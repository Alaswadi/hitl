const axios = require('axios');
const { getSession, updateStatus, saveChatHistory } = require('./db');
const { generateAIResponse } = require('./ai');

const MOSAAEDAK_API_URL = process.env.MOSAAEDAK_API_URL;
const MOSAAEDAK_API_KEY = process.env.MOSAAEDAK_API_KEY;
const COST_PER_MESSAGE = parseFloat(process.env.COST_PER_MESSAGE || '0.03');

/**
 * Fetch WhatsApp tenant config from Mosaaedak by bot phone number.
 * Returns { tenantId, prompt, aiModel, textmebotApiKey }
 */
async function fetchWhatsappConfig(botPhone) {
  const url = `${MOSAAEDAK_API_URL}/api/integrations/whatsapp/config/${encodeURIComponent(botPhone)}`;
  const response = await axios.get(url, {
    headers: { 'X-API-Key': MOSAAEDAK_API_KEY },
    timeout: 5000,
  });
  return response.data;
}

/**
 * Send a message to WhatsApp via TextMeBot using the tenant's own API key.
 */
async function sendWhatsappMessage(recipient, text, textmebotApiKey) {
  const url = `https://api.textmebot.com/send.php?recipient=${encodeURIComponent(recipient)}&apikey=${encodeURIComponent(textmebotApiKey)}&text=${encodeURIComponent(text)}`;
  await axios.get(url, { timeout: 10000 });
}

/**
 * Log message usage back to Mosaaedak for billing.
 */
async function logUsage(tenantId, direction, content, fromPhone) {
  try {
    await axios.post(
      `${MOSAAEDAK_API_URL}/api/integrations/n8n/usage`,
      {
        tenantId,
        direction,
        content,
        channel: 'WHATSAPP',
        from: fromPhone,
        cost: direction === 'OUTBOUND' ? COST_PER_MESSAGE : 0,
        deduct: direction === 'OUTBOUND',
      },
      {
        headers: { 'X-API-Key': MOSAAEDAK_API_KEY },
        timeout: 5000,
      }
    );
  } catch (err) {
    // Non-fatal — log but don't crash message flow
    console.error('Failed to log usage:', err.message);
  }
}

/**
 * Handle incoming TextMeBot webhooks.
 * Payload: { type, from, from_name, to, file, message }
 */
async function processWhatsappWebhook(body) {
  // Basic input validation
  if (!body || typeof body.message !== 'string' || !body.message.trim()) return;
  if (!body.from || !body.to) return;

  const senderId = String(body.from).trim();
  const botNumber = String(body.to).trim();
  const incomingText = body.message.trim();

  // If the message is sent FROM the bot number it's an admin reply — pause the bot
  if (senderId === botNumber) {
    // 'to' is the customer's number
    const customerId = String(body.to).trim(); // this case shouldn't fire, but guard anyway
    console.log(`[WA] Admin message detected — ignoring self-echo for ${customerId}`);
    return;
  }

  // 1. Fetch tenant config by bot number
  let config;
  try {
    config = await fetchWhatsappConfig(botNumber);
  } catch (err) {
    console.error(`[WA] Cannot find tenant for bot number ${botNumber}:`, err.message);
    return;
  }

  const { tenantId, prompt, aiModel, textmebotApiKey } = config;

  if (!textmebotApiKey) {
    console.error(`[WA] No TextMeBot API key configured for tenant ${tenantId}`);
    return;
  }

  // 2. Session key is scoped to tenant + customer
  const sessionKey = `wa:${tenantId}:${senderId}`;

  // 3. Check HITL state
  let session = getSession(sessionKey);

  if (session && session.status === 'human_handling') {
    const hitlTimeout = parseInt(process.env.HITL_TIMEOUT_MINUTES || '30', 10);
    const updatedAt = new Date(session.updated_at.replace(' ', 'T') + 'Z');
    const diffMinutes = (Date.now() - updatedAt.getTime()) / (1000 * 60);

    if (diffMinutes > hitlTimeout) {
      console.log(`[WA] HITL timeout reached for ${senderId}. Reverting to bot_active.`);
      updateStatus(sessionKey, 'bot_active');
      session.status = 'bot_active';
    } else {
      console.log(`[WA] ${senderId} is in human_handling — message skipped.`);
      return;
    }
  }

  // 4. Human takeover keyword check
  const humanKeywords = ['موظف', 'بشري', 'خدمة العملاء', 'مساعدة', 'التحدث مع شخص', 'اكلم حد'];
  if (humanKeywords.some((kw) => incomingText.includes(kw))) {
    console.log(`[WA] ${senderId} requested human agent via keyword.`);
    updateStatus(sessionKey, 'human_handling');
    await sendWhatsappMessage(senderId, 'تم تحويلك إلى خدمة العملاء. سيقوم أحد موظفينا بالرد عليك قريباً.', textmebotApiKey);
    return;
  }

  const chatHistory = session ? session.chat_history : [];

  // 5. Log inbound message
  await logUsage(tenantId, 'INBOUND', incomingText, senderId);

  try {
    // 6. Generate AI response
    let aiReplyText = await generateAIResponse(prompt, chatHistory, incomingText, aiModel);

    // 7. AI-driven HITL check
    if (aiReplyText.includes('[PAUSE_BOT]')) {
      console.log(`[WA] AI requested HITL pause for ${senderId}.`);
      updateStatus(sessionKey, 'human_handling');
      aiReplyText = aiReplyText.replace(/\[PAUSE_BOT\]/gi, '').trim();
      if (!aiReplyText) {
        aiReplyText = 'تم تحويلك إلى خدمة العملاء. سيقوم أحد موظفينا بالرد عليك قريباً.';
      }
    }

    // 8. Save chat history
    const newHistory = [
      ...chatHistory,
      { role: 'user', content: incomingText },
      { role: 'assistant', content: aiReplyText },
    ];
    saveChatHistory(sessionKey, newHistory, 'bot_active');

    // 9. Send reply
    await sendWhatsappMessage(senderId, aiReplyText, textmebotApiKey);

    // 10. Log outbound message
    await logUsage(tenantId, 'OUTBOUND', aiReplyText, senderId);

  } catch (err) {
    console.error(`[WA] Error processing message for ${senderId}:`, err.message);
  }
}

module.exports = { processWhatsappWebhook };
