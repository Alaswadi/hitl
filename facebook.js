const axios = require('axios');
const { getSession, updateStatus, saveChatHistory } = require('./db');
const { generateAIResponse } = require('./ai');

const MOSAAEDAK_API_KEY = process.env.MOSAAEDAK_API_KEY;

/**
 * Fetch bot configuration from Mosaaedak API
 * @param {string} pageId - The Facebook Page ID
 */
async function fetchBotConfig(pageId) {
  try {
    const url = `https://api.mosaaedak.com/api/integrations/facebook/config/${pageId}`;
    const response = await axios.get(url, {
      headers: {
        'X-API-Key': MOSAAEDAK_API_KEY
      }
    });
    return response.data; // expects { facebookAccessToken, facebookPrompt }
  } catch (error) {
    console.error('Error fetching bot config:', error.message);
    throw error;
  }
}

/**
 * Send a message to Facebook Messenger using the Graph API
 * @param {string} pageId - The Page ID sending the message
 * @param {string} customerId - The recipient's user ID
 * @param {string} text - The AI generated text
 * @param {string} accessToken - The page's access token
 */
async function sendFacebookMessage(pageId, customerId, text, accessToken) {
  try {
    // API v24.0 requires POST matching graph.facebook.com endpoint
    const url = `https://graph.facebook.com/v24.0/${pageId}/messages?access_token=${accessToken}`;
    const payload = {
      recipient: { id: customerId },
      messaging_type: 'RESPONSE',
      message: { text: text }
    };

    await axios.post(url, payload);
    console.log(`Successfully sent message to ${customerId}`);
  } catch (error) {
    console.error('Error sending message to Facebook:', error.response ? error.response.data : error.message);
  }
}

/**
 * Handle incoming webhooks
 */
async function processWebhookEvent(body) {
  if (body.object !== 'page') {
    return; // Ignore non-page webhooks
  }

  for (const entry of body.entry) {
    const pageId = entry.id; // The recipient.id / page ID
    const webhookEvent = entry.messaging[0];
    
    if (!webhookEvent || !webhookEvent.message) {
      continue; // Not a message event
    }

    const senderId = webhookEvent.sender.id;
    const recipientId = webhookEvent.recipient.id;
    const message = webhookEvent.message;

    // Is this a message sent BY the page (e.g. human admin reply via Inbox)?
    // Usually, messages sent by the page come with an 'is_echo' flag.
    // Or senderId strictly matches pageId.
    const isSentByPage = (senderId === pageId) || message.is_echo;

    if (isSentByPage) {
      // It's a Human Admin replying. The customer is actually the recipientId here.
      const customerId = (senderId === pageId) ? recipientId : recipientId; // For echos, recipient is the user.
      console.log(`Human admin replied to ${customerId}. Pausing bot.`);
      updateStatus(customerId, 'human_handling');
      continue;
    }

    // Otherwise, it's a message from a normal customer to the Page
    const customerId = senderId;
    const incomingText = message.text;

    if (!incomingText) continue; // Ignore attachments/stickers for now

    // 1. Check DB State
    let session = getSession(customerId);
    
    if (session && session.status === 'human_handling') {
      console.log(`Message from ${customerId} ignored because human_handling is active.`);
      continue; // Return without AI generation
    }

    // 2. We proceed to AI Generation if status is 'bot_active' or new user
    const chatHistory = session ? session.chat_history : [];

    try {
      // 3. Get Configuration
      // Check if we have a hardcoded token in the Environment Variables
      let facebookAccessToken = process.env[`PAGE_TOKEN_${pageId}`];
      let facebookPrompt = process.env[`PAGE_PROMPT_${pageId}`] || "You are a helpful customer service representative. Be polite, concise, and helpful.";

      // If we don't have a token, or want dynamic prompt, we fetch from Mosaaedak API fallback
      try {
        const config = await fetchBotConfig(pageId);
        if (config.facebookAccessToken && !facebookAccessToken) {
          facebookAccessToken = config.facebookAccessToken;
        }
        if (config.facebookPrompt) {
          facebookPrompt = config.facebookPrompt;
        }
      } catch (err) {
        console.log("Could not fetch Mosaaedak API config, falling back to local defaults if available.");
      }

      if (!facebookAccessToken) {
        throw new Error(`No access token available for page ID ${pageId}`);
      }

      // 4. Generate AI Response
      const aiReplyText = await generateAIResponse(facebookPrompt, chatHistory, incomingText);

      // 5. Update Chat History
      // Keep only recent 10 messages (5 hits, 5 replies) or similar to save context limit if needed
      // but for now append everything:
      const newHistory = [
        ...chatHistory,
        { role: 'user', content: incomingText },
        { role: 'assistant', content: aiReplyText }
      ];
      saveChatHistory(customerId, newHistory, 'bot_active');

      // 6. Send Response to FB
      await sendFacebookMessage(pageId, customerId, aiReplyText, facebookAccessToken);

    } catch (error) {
      console.error(`Error processing message for ${customerId}:`, error.message);
    }
  }
}

module.exports = {
  processWebhookEvent
};
