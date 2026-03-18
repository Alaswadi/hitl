const axios = require('axios');
const { getSession, updateStatus, saveChatHistory } = require('./db');
const { generateAIResponse } = require('./ai');

const TEXTMEBOT_API_KEY = process.env.TEXTMEBOT_API_KEY;

/**
 * Send a message to WhatsApp via TextMeBot
 * @param {string} recipient - The recipient's phone number
 * @param {string} text - The AI generated text
 */
async function sendWhatsappMessage(recipient, text) {
  try {
    // TextMeBot supports GET requests for sending simple text messages
    const url = `https://api.textmebot.com/send.php?recipient=${recipient}&apikey=${TEXTMEBOT_API_KEY}&text=${encodeURIComponent(text)}`;
    await axios.get(url);
    console.log(`Successfully sent WhatsApp message to ${recipient}`);
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.message);
  }
}

/**
 * Handle incoming TextMeBot webhooks
 */
async function processWhatsappWebhook(body) {
  // textmebot webhook format: { type, from, from_name, to, file, message }
  if (!body.message) return;
  
  const senderId = body.from;
  const recipientId = body.to;
  const incomingText = body.message;
  
  const WHATSAPP_PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER;
  // If WHATSAPP_PHONE_NUMBER is defined, use it. Otherwise, assume 'to' is the bot's number
  const botNumber = WHATSAPP_PHONE_NUMBER || recipientId; 
  
  // If the message is sent BY the bot's number, it implies human admin takeover
  const isSentByBot = (senderId === botNumber);

  if (isSentByBot) {
    // If the human admin replied, the 'to' field would be the customer's number
    const customerId = recipientId;
    console.log(`Human admin replied to ${customerId} via WhatsApp. Pausing bot.`);
    updateStatus(customerId, 'human_handling');
    return;
  }

  // Otherwise, it's a message from a normal customer to the bot
  const customerId = senderId;
  
  // 1. Check DB State
  let session = getSession(customerId);
  if (session && session.status === 'human_handling') {
    const hitlTimeout = parseInt(process.env.HITL_TIMEOUT_MINUTES || '30', 10);
    const updatedAtStr = session.updated_at.replace(' ', 'T') + 'Z';
    const updatedAt = new Date(updatedAtStr);
    const now = new Date();
    const diffMinutes = (now - updatedAt) / (1000 * 60);

    if (diffMinutes > hitlTimeout) {
      console.log(`Human handling timeout (${hitlTimeout}m) reached for ${customerId}. Reverting to bot_active.`);
      updateStatus(customerId, 'bot_active');
      session.status = 'bot_active';
    } else {
      console.log(`WhatsApp message from ${customerId} ignored because human_handling is active. (${Math.round(hitlTimeout - diffMinutes)}m remaining)`);
      return;
    }
  }

  const chatHistory = session ? session.chat_history : [];

  try {
    const whatsappPrompt = process.env.WHATSAPP_PROMPT || "You are a helpful customer service representative interacting over WhatsApp. Be polite, concise, and helpful.";

    // 2. Generate AI Response
    const aiReplyText = await generateAIResponse(whatsappPrompt, chatHistory, incomingText);

    // 3. Update Chat History
    const newHistory = [
      ...chatHistory,
      { role: 'user', content: incomingText },
      { role: 'assistant', content: aiReplyText }
    ];
    saveChatHistory(customerId, newHistory, 'bot_active');

    // 4. Send Response via TextMeBot
    await sendWhatsappMessage(customerId, aiReplyText);
    
  } catch (error) {
    console.error(`Error processing WhatsApp message for ${customerId}:`, error.message);
  }
}

module.exports = { processWhatsappWebhook };
