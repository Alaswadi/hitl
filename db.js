const Database = require('better-sqlite3');
const path = require('path');

// Connect to SQLite database (creates the file if it doesn't exist)
const dbPath = path.resolve(__dirname, 'data', 'sessions.db');
const db = new Database(dbPath);

// Initialize database schema
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      customer_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'bot_active',
      chat_history TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Database initialized successfully.');
}

// Get customer session
function getSession(customerId) {
  const row = db.prepare('SELECT * FROM sessions WHERE customer_id = ?').get(customerId);
  if (row) {
    try {
      row.chat_history = JSON.parse(row.chat_history);
    } catch (e) {
      row.chat_history = [];
    }
  }
  return row;
}

// Create or update session status
function updateStatus(customerId, status) {
  const existing = db.prepare('SELECT 1 FROM sessions WHERE customer_id = ?').get(customerId);
  if (existing) {
    db.prepare('UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?').run(status, customerId);
  } else {
    // If updating status for a new session, create it empty
    db.prepare('INSERT INTO sessions (customer_id, status, chat_history) VALUES (?, ?, ?)').run(customerId, status, '[]');
  }
}

// Save chat history for a customer
function saveChatHistory(customerId, chatHistoryArray, status = 'bot_active') {
  const existing = db.prepare('SELECT 1 FROM sessions WHERE customer_id = ?').get(customerId);
  const historyText = JSON.stringify(chatHistoryArray);

  if (existing) {
    db.prepare('UPDATE sessions SET chat_history = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?').run(historyText, status, customerId);
  } else {
    db.prepare('INSERT INTO sessions (customer_id, status, chat_history) VALUES (?, ?, ?)').run(customerId, status, historyText);
  }
}

module.exports = {
  db,
  initDb,
  getSession,
  updateStatus,
  saveChatHistory
};
