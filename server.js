require('dotenv').config();
const express = require('express');
const { initDb } = require('./db');
const { processWebhookEvent } = require('./facebook');

const app = express();
const PORT = process.env.PORT || 9000;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;

// Needed to parse incoming JSON payload from Facebook
app.use(express.json());

// Initialize the SQLite database
initDb();

// Generic health check endpoint
app.get('/', (req, res) => {
  res.send('Mosaaedak HitL Bot is running.');
});

// GET /webhook: Standard Facebook Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(403);
  }
});

// POST /webhook: Handle incoming messages
app.post('/webhook', async (req, res) => {
  let body = req.body;

  // Assume process is non-blocking (return 200 OK immediately as per FB documentation)
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');
    
    // Process the event asynchronously
    processWebhookEvent(body).catch(err => {
      console.error('Unhandled webhook error:', err);
    });
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is listening on port ${PORT}`);
});
