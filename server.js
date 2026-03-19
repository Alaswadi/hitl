require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./db');
const { processWebhookEvent } = require('./facebook');
const { processWhatsappWebhook } = require('./whatsapp');

// ---------------------------------------------------------------------------
// Validate required environment variables at startup
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'FB_VERIFY_TOKEN',
  'FB_APP_SECRET',
  'MOSAAEDAK_API_KEY',
  'MOSAAEDAK_API_URL',
  'OPENROUTER_API_KEY',
  'WHATSAPP_WEBHOOK_SECRET',
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 9999;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const WHATSAPP_WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
app.use(helmet());

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

app.use(generalLimiter);

// ---------------------------------------------------------------------------
// Body parsing — capture raw body for FB signature verification
// ---------------------------------------------------------------------------
app.use(
  express.json({
    limit: '10kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------------------------------------------------------------------------
// Signature verification middleware
// ---------------------------------------------------------------------------

/**
 * Verify Facebook X-Hub-Signature-256 header.
 * Must run AFTER express.json (rawBody is set in verify callback above).
 */
function verifyFBSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return res.sendStatus(401);
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', FB_APP_SECRET).update(req.rawBody).digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return res.sendStatus(403);
    }
  } catch {
    // Buffers have different lengths
    return res.sendStatus(403);
  }

  next();
}

/**
 * Verify TextMeBot webhook secret token sent as a query param.
 * Each tenant's TextMeBot webhook URL must be set to:
 *   https://<gateway>/whatsapp/webhook?token=<WHATSAPP_WEBHOOK_SECRET>
 */
function verifyTextMeBotSecret(req, res, next) {
  const token = req.query.token;
  if (!token || token !== WHATSAPP_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  next();
}

// ---------------------------------------------------------------------------
// Initialize DB
// ---------------------------------------------------------------------------
initDb();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send('Mosaaedak Gateway is running.');
});

// Facebook webhook verification (GET — no signature needed, just verify token)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// Facebook webhook events (POST — signature verified)
app.post('/webhook', webhookLimiter, verifyFBSignature, async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');
    processWebhookEvent(body).catch((err) => {
      console.error('Unhandled Facebook webhook error:', err.message);
    });
  } else {
    res.sendStatus(404);
  }
});

// WhatsApp (TextMeBot) webhook (POST — secret token verified)
app.post('/whatsapp/webhook', webhookLimiter, verifyTextMeBotSecret, async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  processWhatsappWebhook(req.body).catch((err) => {
    console.error('Unhandled WhatsApp webhook error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mosaaedak Gateway listening on port ${PORT}`);
});
