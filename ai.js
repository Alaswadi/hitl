const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

/**
 * Generate AI response using OpenRouter
 * @param {string} systemPrompt - Dynamic system prompt fetched from Mosaaedak configs
 * @param {Array} chatHistory - Previous interaction objects [{ role: 'user'|'assistant', content: string }]
 * @param {string} userMessage - Latest user message
 * @returns {string} The AI generated text
 */
async function generateAIResponse(systemPrompt, chatHistory, userMessage) {
  try {
    // Formulate the conversation log payload
    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory,
      { role: 'user', content: userMessage }
    ];

    const response = await openai.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: messages,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating AI response via OpenRouter:', error.message);
    throw error;
  }
}

module.exports = {
  generateAIResponse
};
