// Lazy-load the OpenAI client so the server starts fine without the API key.
let _openaiClient = null;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (_openaiClient) return _openaiClient;
  try {
    const { OpenAI } = require('openai');
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 });
    return _openaiClient;
  } catch { return null; }
}

module.exports = { getOpenAI };
