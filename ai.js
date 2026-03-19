const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

/**
 * Generate AI response via OpenRouter.
 * @param {string} systemPrompt
 * @param {Array}  chatHistory  - [{ role, content }, ...]
 * @param {string} userMessage
 * @param {string} [model]      - OpenRouter model ID (falls back to DEFAULT_MODEL)
 */
async function generateAIResponse(systemPrompt, chatHistory, userMessage, model) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model: model || DEFAULT_MODEL,
    messages,
  });

  return response.choices[0].message.content;
}

module.exports = { generateAIResponse };
