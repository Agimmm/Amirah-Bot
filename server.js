require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(system, messages, max_tokens = 1000) {
  const fetch = (await import('node-fetch')).default;
  const groqMessages = [];
  if (system) groqMessages.push({ role: 'system', content: system });
  groqMessages.push(...messages.map(m => ({ role: m.role, content: String(m.content) })));

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: groqMessages,
      max_tokens,
      temperature: 0.7
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || '';
}

app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages, max_tokens } = req.body;
    const text = await callGroq(system, messages, max_tokens);
    res.json({ content: [{ type: 'text', text }] });
  } catch (e) {
    console.error('Groq error:', e.message);
    res.status(500).json({ error: { message: e.message } });
  }
});

app.use(express.static('.'));

const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server jalan di http://localhost:${PORT}`));