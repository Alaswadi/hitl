const axios = require('axios');
const { getSession, updateStatus, saveChatHistory } = require('./db');
const { generateAIResponse } = require('./ai');

const MOSAAEDAK_API_URL = process.env.MOSAAEDAK_API_URL;
const MOSAAEDAK_API_KEY = process.env.MOSAAEDAK_API_KEY;
const COST_PER_MESSAGE = parseFloat(process.env.COST_PER_MESSAGE || '0.03');

/**
 * Fetch tenant config from Mosaaedak by Facebook Page ID.
 * Returns { tenantId, facebookAccessToken, activePrompt, aiModel }
 */
async function fetchBotConfig(pageId) {
  const url = `${MOSAAEDAK_API_URL}/api/integrations/facebook/config/${encodeURIComponent(pageId)}`;
  const response = await axios.get(url, {
    headers: { 'X-API-Key': MOSAAEDAK_API_KEY },
    timeout: 5000,
  });
  return response.data;
}

/**
 * Send a message via the Facebook Graph API.
 */
async function sendFacebookMessage(pageId, customerId, text, accessToken) {
  const url = `https://graph.facebook.com/v24.0/${pageId}/messages?access_token=${accessToken}`;
  await axios.post(
    url,
    {
      recipient: { id: customerId },
      messaging_type: 'RESPONSE',
      message: { text },
    },
    { timeout: 10000 }
  );
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
        channel: 'MESSENGER',
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
    console.error('[FB] Failed to log usage:', err.message);
  }
}

/**
 * Handle incoming Facebook webhook events.
 */
async function processWebhookEvent(body) {
  if (body.object !== 'page') return;

  for (const entry of body.entry) {
    const pageId = entry.id;
    const webhookEvent = entry.messaging?.[0];

    if (!webhookEvent?.message) continue;

    const senderId = webhookEvent.sender.id;
    const recipientId = webhookEvent.recipient.id;
    const message = webhookEvent.message;

    // Admin reply via Page Inbox — pause bot
    const isSentByPage = senderId === pageId || message.is_echo;
    if (isSentByPage) {
      const customerId = recipientId;
      // We don't know the tenantId here without a DB lookup, so use pageId as scope
      const sessionKey = `fb:${pageId}:${customerId}`;
      console.log(`[FB] Admin replied to ${customerId} — pausing bot.`);
      updateStatus(sessionKey, 'human_handling');
      continue;
    }

    const customerId = senderId;
    const incomingText = message.text;
    if (!incomingText || typeof incomingText !== 'string') continue;

    // 1. Fetch tenant config
    let config;
    try {
      config = await fetchBotConfig(pageId);
    } catch (err) {
      console.error(`[FB] Cannot find tenant for page ${pageId}:`, err.message);
      continue;
    }

    const { tenantId, facebookAccessToken, activePrompt, aiModel } = config;

    if (!facebookAccessToken) {
      console.error(`[FB] No access token for page ${pageId}`);
      continue;
    }

    // 2. Session key scoped to tenant + customer
    const sessionKey = `fb:${tenantId}:${customerId}`;
    let session = getSession(sessionKey);

    // 3. HITL timeout check
    if (session && session.status === 'human_handling') {
      const hitlTimeout = parseInt(process.env.HITL_TIMEOUT_MINUTES || '30', 10);
      const updatedAt = new Date(session.updated_at.replace(' ', 'T') + 'Z');
      const diffMinutes = (Date.now() - updatedAt.getTime()) / (1000 * 60);

      if (diffMinutes > hitlTimeout) {
        console.log(`[FB] HITL timeout reached for ${customerId}. Reverting to bot_active.`);
        updateStatus(sessionKey, 'bot_active');
        session.status = 'bot_active';
      } else {
        console.log(`[FB] ${customerId} is in human_handling — message skipped.`);
        continue;
      }
    }

    const chatHistory = session ? session.chat_history : [];

    // 4. Log inbound
    await logUsage(tenantId, 'INBOUND', incomingText, customerId);

    try {
      // 5. Generate AI response
      const aiReplyText = await generateAIResponse(activePrompt, chatHistory, incomingText, aiModel);

      // 6. Save chat history
      const newHistory = [
        ...chatHistory,
        { role: 'user', content: incomingText },
        { role: 'assistant', content: aiReplyText },
      ];
      saveChatHistory(sessionKey, newHistory, 'bot_active');

      // 7. Send reply
      await sendFacebookMessage(pageId, customerId, aiReplyText, facebookAccessToken);

      // 8. Log outbound
      await logUsage(tenantId, 'OUTBOUND', aiReplyText, customerId);

    } catch (err) {
      console.error(`[FB] Error processing message for ${customerId}:`, err.message);
    }
  }
}

module.exports = { processWebhookEvent };
