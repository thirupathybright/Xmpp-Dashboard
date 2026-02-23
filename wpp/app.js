// app.js - WPP WhatsApp Manager with AI & SQL
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// AI and Database helpers
const SessionStore = require('./config/sessionStore');
const QueueStore = require('./config/queueStore');
const ChatMemoryStore = require('./config/chatMemoryStore');
const DatabaseHelper = require('./config/databaseHelper');
const SQLAgent = require('./config/sqlAgent');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const port = 3000;

// AI Configuration
const AI_CONFIG = {
  API_KEY: 'sk_sggnlnzm_2TzPY0ameO13qAWYxikieql0',
  API_URL: 'https://api.sarvam.ai/v1/chat/completions',
  MODEL: 'sarvam-m',
  SYSTEM_PROMPT: `You are an AI assistant for Thirupathybright Industries with DIRECT DATABASE ACCESS.

CAPABILITIES:
- Real-time access to company database
- Automatic SQL query generation for orders, customers, dispatches, invoices, weightments
- You will receive actual data from the database - present it clearly and concisely

WHEN PRESENTING ORDER INFORMATION, SHOW ONLY:

Order Number: [order_number]
Status: [status]
Material Status: [material_status] (only for pending/in_progress)

PO Number: [po_number]
PO Date: [po_date]
Expected Delivery Date: [expected_date] (only for pending/in_progress)

Customer Name: [customer_name]

Material: [material]
Quantity: [quantity_kg] kg
Rate: [rate]
Payment Terms: [payment_terms]
Delivery Address: [delivery_address]

Current Status:
Total Dispatched: [total_dispatched] kg
Remaining: [remaining_qty] kg

(If dispatches exist, list each dispatch with weight and completion date)

STATUS-BASED RULES:
- PENDING: Show "Production is yet to begin" if material_status is empty
- IN_PROGRESS: Show material status, expected date, dispatch progress, remaining quantity
- COMPLETED: Show dispatch details with dates (DO NOT show material status or expected date)

Keep responses simple and concise. No extra formatting, emojis, or verbose explanations.`
};

// Anti-ban rate limiting
const sessionUsage = new Map();

const ANTI_BAN = {
  MIN_DELAY_MS: 60000,
  MAX_DELAY_MS: 180000,
  MIN_TYPING_MS: 2000,
  MAX_TYPING_MS: 8000,
  MIN_READING_MS: 1000,
  MAX_READING_MS: 3000,
  MAX_PER_INTERVAL: 1,
  INTERVAL_MS: 60000,
  MAX_MESSAGES_PER_HOUR: 50,
  BREAK_AFTER_MESSAGES: 10,
  BREAK_DURATION_MIN_MS: 300000,
  BREAK_DURATION_MAX_MS: 900000,
  RANDOM_PRESENCE_UPDATE: true,
  PRESENCE_UPDATE_CHANCE: 0.3,
  SIMULATE_READ_RECEIPTS: true,
  READ_DELAY_MIN_MS: 500,
  READ_DELAY_MAX_MS: 2000,
  TYPING_PAUSES: true,
  TYPING_PAUSE_CHANCE: 0.2,
  TYPING_PAUSE_DURATION_MS: 1000
};

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Multi-session management
const sessions = new Map();
let currentSessionIndex = 0;

// Message queue with size limit to prevent memory leaks
const MAX_QUEUE_SIZE = 1000;
const messageQueue = [];
let isProcessingQueue = false;

// Queue promise resolvers (messageId -> {resolve, reject})
const queueResolvers = new Map();

// Per-session rate limiting for flag-based messages (2-3 minute delay)
// Structure: { sessionId: { lastMessageTime: timestamp, nextAllowedTime: timestamp } }
const sessionRateLimits = new Map();

// Flag-based message queue with size limit
const flagMessageQueue = [];
const MAX_FLAG_QUEUE_SIZE = 500;
let isFlagQueueProcessing = false;

// Memory monitoring
let lastMemoryCheck = Date.now();
const MEMORY_CHECK_INTERVAL = 300000; // 5 minutes

// Ensure directories exist
const tokensDir = path.join(__dirname, 'tokens');
const uploadsDir = path.join(__dirname, 'uploads');

[tokensDir, uploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ========== MEMORY LEAK PREVENTION ==========

// Clean up disconnected sessions from memory
function cleanupDisconnectedSessions() {
  let cleaned = 0;
  const now = Date.now();
  const DISCONNECT_TIMEOUT = 3600000; // 1 hour

  for (const [sessionId, sessionData] of sessions.entries()) {
    // Remove sessions that have been disconnected for more than 1 hour
    if (!sessionData.status.isLoggedIn && sessionData.status.status === 'DISCONNECTED') {
      const disconnectTime = sessionData.status.disconnectedAt || 0;
      if (now - disconnectTime > DISCONNECT_TIMEOUT) {
        sessions.delete(sessionId);
        sessionRateLimits.delete(sessionId);
        sessionUsage.delete(sessionId);
        cleaned++;
        console.log(`🧹 Cleaned up disconnected session: ${sessionId}`);
      }
    }
  }

  return cleaned;
}

// Clean up old rate limits
function cleanupRateLimits() {
  let cleaned = 0;
  const now = Date.now();
  const RATE_LIMIT_EXPIRY = 7200000; // 2 hours

  for (const [sessionId, rateLimit] of sessionRateLimits.entries()) {
    // Remove rate limits older than 2 hours
    if (now - rateLimit.lastMessageTime > RATE_LIMIT_EXPIRY) {
      sessionRateLimits.delete(sessionId);
      cleaned++;
    }
  }

  return cleaned;
}

// Check and limit queue sizes
function enforceQueueLimits() {
  let rejected = 0;

  // Limit message queue
  while (messageQueue.length > MAX_QUEUE_SIZE) {
    const job = messageQueue.shift();
    if (job && job.reject) {
      job.reject(new Error('Queue full - message rejected'));
      rejected++;
    }
  }

  // Limit flag message queue
  while (flagMessageQueue.length > MAX_FLAG_QUEUE_SIZE) {
    const job = flagMessageQueue.shift();
    if (job && job.reject) {
      job.reject(new Error('Queue full - message rejected'));
      rejected++;
    }
  }

  if (rejected > 0) {
    console.log(`⚠️ Rejected ${rejected} messages due to queue limits`);
  }

  return rejected;
}

// Memory monitoring and cleanup
function checkMemoryUsage() {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);

  console.log(`\n📊 Memory Usage: Heap ${heapUsedMB}MB / ${heapTotalMB}MB | RSS ${rssMB}MB`);
  console.log(`📈 Active Sessions: ${sessions.size} | Queue: ${flagMessageQueue.length} | Rate Limits: ${sessionRateLimits.size}`);

  // If heap usage is above 80%, force garbage collection (if available)
  const heapUsagePercent = (usage.heapUsed / usage.heapTotal) * 100;
  if (heapUsagePercent > 80) {
    console.log(`⚠️ High memory usage (${Math.round(heapUsagePercent)}%) - running cleanup...`);

    // Clean up old sessions, rate limits, and chat history
    const cleanedSessions = cleanupDisconnectedSessions();
    const cleanedRateLimits = cleanupRateLimits();
    const cleanedChats = ChatMemoryStore.cleanup(3); // Clean chats older than 3 days

    console.log(`✅ Cleaned: ${cleanedSessions} sessions, ${cleanedRateLimits} rate limits, ${cleanedChats} chats`);

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log(`🗑️ Forced garbage collection`);
    }
  }

  lastMemoryCheck = Date.now();
}

// Periodic memory check
setInterval(() => {
  checkMemoryUsage();
  cleanupDisconnectedSessions();
  cleanupRateLimits();
  enforceQueueLimits();
}, MEMORY_CHECK_INTERVAL);

// Generate unique session ID
function generateSessionId() {
  return `wpp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get next available session for round-robin
function getNextSession() {
  const connectedSessions = Array.from(sessions.values())
    .filter(s => s.client && s.status.isLoggedIn);

  if (connectedSessions.length === 0) {
    return null;
  }

  const session = connectedSessions[currentSessionIndex % connectedSessions.length];
  currentSessionIndex = (currentSessionIndex + 1) % connectedSessions.length;

  return session;
}

// Broadcast sessions to all connected clients
function broadcastSessions() {
  const sessionList = Array.from(sessions.entries()).map(([id, data]) => {
    // Always fetch fresh data from JSON file to ensure consistency
    const freshDbData = SessionStore.getSession(id) || {};
    const assignmentData = {
      ot_message_enabled: Boolean(freshDbData.ot_message_enabled),
      checkin_checkout_enabled: Boolean(freshDbData.checkin_checkout_enabled),
      group_message_enabled: Boolean(freshDbData.group_message_enabled),
      pc_automation_enabled: Boolean(freshDbData.pc_automation_enabled),
      delegation_enabled: Boolean(freshDbData.delegation_enabled),
      helpticket_enabled: Boolean(freshDbData.helpticket_enabled),
      ai_mode_enabled: Boolean(freshDbData.ai_mode_enabled),
      ncr_enabled: Boolean(freshDbData.ncr_enabled)
    };

    // Also update in-memory data to keep it in sync
    data.dbData = freshDbData;

    return {
      sessionId: id,
      status: data.status,
      qrCode: data.qrCode,
      createdAt: data.createdAt,
      dbData: assignmentData,
      assignments: assignmentData,  // Include assignments field for frontend consistency
      usage: sessionUsage.get(id)
    };
  });
  io.emit('sessions', sessionList);
}

// ========== AI CHATBOT FUNCTIONS ==========

async function getAIResponse(userMessage, phoneNumber) {
  try {
    let contextMessage = '';

    // Check if this is a new user (no chat history)
    const existingHistory = ChatMemoryStore.getHistory(phoneNumber);
    const isNewUser = !existingHistory || existingHistory.length === 0;

    // If new user and first message is a greeting, send introduction
    if (isNewUser && /^(hi|hello|hey|hii|helo|hiii|namaste|greetings?)$/i.test(userMessage.trim())) {
      console.log(`👋 New user detected: ${phoneNumber}`);
      const introduction = `Hello! Welcome to Thirupathybright Industries.

I'm your AI assistant with direct access to our order management system. I can help you with:

📦 Order Status & Details
- Check order status by order number (e.g., "ORD-2506-0738")
- View material status and expected delivery dates
- Track dispatch progress and remaining quantities

👥 Customer Information
- View all orders for a customer (e.g., "Show SSPL orders")
- Filter by pending, in-progress, or completed status
- See customer order history

🚚 Dispatch Tracking
- Get dispatch details by number (e.g., "DSP-2506-0347")
- Check dispatch weights and completion dates
- View which customer received a dispatch

📊 Order Queries
- List all pending orders
- Show completed orders
- Check orders by status, customer, or date

Just ask me anything about your orders, and I'll fetch the real-time information from our database!

How can I help you today?`;

      // Add introduction to history
      ChatMemoryStore.addMessage(phoneNumber, 'user', userMessage);
      ChatMemoryStore.addMessage(phoneNumber, 'assistant', introduction);

      return introduction;
    }

    // Use SQL Agent for ALL queries - let AI figure out what to query
    console.log(`🤖 Processing with SQL Agent: "${userMessage}"`);

    // Use SQL Agent to automatically generate and execute SQL query
    const sqlResult = await SQLAgent.queryFromNaturalLanguage(userMessage, AI_CONFIG);

    if (sqlResult.success && sqlResult.count > 0) {
      // Data found - format it for AI to present
      contextMessage = SQLAgent.formatResultForAI(sqlResult);
      console.log(`✅ SQL Agent found ${sqlResult.count} results`);
    } else if (sqlResult.success && sqlResult.count === 0) {
      // Query succeeded but no data
      contextMessage = `\n\n[SYSTEM: No data found. The database query executed successfully but returned no results. Have a normal conversation and help the customer.]`;
      console.log(`⚠️ SQL Agent: No results found`);
    } else {
      // Not a database query or query failed - have normal conversation
      contextMessage = '';
      console.log(`💬 Normal conversation mode (not a database query or query failed)`);
    }

    // Add user message with context to history
    const userMessageWithContext = userMessage + contextMessage;
    const updatedHistory = ChatMemoryStore.addMessage(phoneNumber, 'user', userMessageWithContext);

    // Keep only last 10 messages (5 exchanges) to prevent memory bloat
    // This limits memory per conversation while maintaining enough context
    const recentHistory = updatedHistory.slice(-10);

    // Prepare messages for AI API
    const messagesForAPI = [];

    // Add system prompt as first user message if it's a new conversation
    const isNewConversation = recentHistory.length <= 1;

    if (isNewConversation) {
      messagesForAPI.push({
        role: 'user',
        content: `${AI_CONFIG.SYSTEM_PROMPT}\n\nUser: ${recentHistory[0].content}`
      });
    } else {
      // Ensure alternating pattern - only include valid alternating messages
      let lastRole = null;
      for (const msg of recentHistory) {
        if (msg.role !== lastRole) {
          messagesForAPI.push(msg);
          lastRole = msg.role;
        } else {
          console.log(`⚠️ Skipping consecutive ${msg.role} message to maintain alternating pattern`);
        }
      }

      // Ensure first message is from user and last message is from user
      if (messagesForAPI.length === 0) {
        messagesForAPI.push(recentHistory[recentHistory.length - 1]);
      } else if (messagesForAPI[0].role !== 'user') {
        while (messagesForAPI.length > 0 && messagesForAPI[0].role !== 'user') {
          messagesForAPI.shift();
        }
        if (messagesForAPI.length === 0) {
          messagesForAPI.push(recentHistory[recentHistory.length - 1]);
        }
      }

      // Ensure last message is from user
      if (messagesForAPI[messagesForAPI.length - 1].role !== 'user') {
        messagesForAPI.push(recentHistory[recentHistory.length - 1]);
      }
    }

    console.log('📤 Sending to AI API:', JSON.stringify(messagesForAPI, null, 2).substring(0, 500));

    // Call Sarvam AI API
    const response = await fetch(AI_CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': AI_CONFIG.API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: messagesForAPI,
        model: AI_CONFIG.MODEL
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ AI API Error Response:', errorText);
      throw new Error(`AI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ AI API Response:', JSON.stringify(data).substring(0, 200));

    // Extract AI response
    const aiMessage = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    // Add AI response to history
    ChatMemoryStore.addMessage(phoneNumber, 'assistant', aiMessage);

    return aiMessage;

  } catch (error) {
    console.error('❌ AI Error:', error);
    return 'Sorry, I am experiencing technical difficulties. Please try again later.';
  }
}

function clearConversationHistory(phoneNumber) {
  ChatMemoryStore.clearHistory(phoneNumber);
  console.log(`🗑️ Cleared conversation history for ${phoneNumber}`);
}

// Create a new WhatsApp client using whatsapp-web.js
async function createClient(sessionId) {
  // PREVENT DUPLICATE CLIENT CREATION - Check if client already exists
  let sessionData = sessions.get(sessionId);
  if (sessionData && sessionData.client) {
    console.log(`⚠️  Session ${sessionId} already has an active client, skipping creation`);
    return;
  }

  console.log(`📱 Creating WhatsApp client for session: ${sessionId}`);

  // Load JSON data for this session
  const dbData = SessionStore.getSession(sessionId);

  if (!sessionData) {
    sessionData = {
      client: null,
      status: { status: 'INITIALIZING', isLoggedIn: false, number: null },
      qrCode: null,
      sessionId: sessionId,
      createdAt: new Date(),
      dbData: dbData || {}
    };
    sessions.set(sessionId, sessionData);
  } else {
    // Update dbData if session already exists
    sessionData.dbData = dbData || {};
    sessionData.status = { status: 'INITIALIZING', isLoggedIn: false, number: null };
  }

  broadcastSessions();

  try {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: tokensDir
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-web-security',
          '--ignore-certificate-errors',
          // Memory optimization arguments (safe for whatsapp-web.js)
          '--disable-extensions',
          '--disable-plugins',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-renderer-backgrounding',
          '--force-color-profile=srgb',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          // Additional args to help with connection stability
          '--disable-site-isolation-trials',
          '--disable-features=IsolateOrigins,site-per-process'
        ],
        timeout: 0, // Disable timeout
        protocolTimeout: 120000 // Increase protocol timeout to 120 seconds (default is 30s)
      },
      qrMaxRetries: 5,
      restartOnAuthFail: true,
      authTimeoutMs: 0, // Disable auth timeout
      qrTimeoutMs: 0 // Disable QR timeout
    });

    // QR Code event - this is called when QR is ready to scan
    client.on('qr', async (qr) => {
      console.log(`📲 QR Code received for ${sessionId}`);

      // Store raw QR string for frontend QRCode library to generate
      sessionData.qrCode = qr;
      sessionData.status = {
        status: 'QR_RECEIVED',  // Match frontend expectation
        isLoggedIn: false,
        number: null
      };

      // Emit to socket - send raw QR string
      io.emit('qr', { sessionId, qrCode: qr, qrRaw: qr });
      broadcastSessions();
    });

    // Ready event - called when client is authenticated and ready
    client.on('ready', async () => {
      console.log(`✅ Client ${sessionId} is ready!`);

      try {
        const info = client.info;
        const phoneNumber = info.wid.user;

        sessionData.status = {
          status: 'CONNECTED',
          isLoggedIn: true,
          number: phoneNumber,
          connectedAt: new Date()
        };
        sessionData.qrCode = null;
        sessionData.client = client;

        // Save to JSON
        SessionStore.saveSession(sessionId, phoneNumber, 'connected');
        sessionData.dbData = SessionStore.getSession(sessionId);

        console.log(`✅ ${sessionId} connected as ${phoneNumber}`);
        io.emit('ready', { sessionId, phoneNumber });
        broadcastSessions();
      } catch (err) {
        console.error(`Error getting client info: ${err.message}`);
      }
    });

    // Authenticated event
    let authCount = 0;
    client.on('authenticated', () => {
      authCount++;
      console.log(`🔐 Client ${sessionId} authenticated (${authCount}x)`);
      console.log(`⏳ Waiting for 'ready' event... (this may take 30-60 seconds)`);
      sessionData.status = {
        status: 'AUTHENTICATED',
        isLoggedIn: false,
        number: null
      };
      sessionData.qrCode = null;
      broadcastSessions();

      // If authenticated more than once, try to force connect after 15 seconds
      if (authCount === 1) {
        setTimeout(async () => {
          if (!sessionData.status.isLoggedIn) {
            console.log(`⚠️ Ready event didn't fire for ${sessionId} after 15s, trying to force connection...`);

            try {
              // Force a check by accessing the pupPage directly
              if (client && client.pupPage) {
                console.log(`🔍 Checking page state...`);

                // Wait a bit more for WhatsApp Web to load
                await new Promise(resolve => setTimeout(resolve, 10000));

                // Try to get client info
                if (client.info && client.info.wid) {
                  const phoneNumber = client.info.wid.user;
                  console.log(`✅ Force retrieved client info: ${phoneNumber}`);

                  sessionData.status = {
                    status: 'CONNECTED',
                    isLoggedIn: true,
                    number: phoneNumber,
                    connectedAt: new Date()
                  };
                  sessionData.qrCode = null;
                  sessionData.client = client;

                  // Save to JSON
                  SessionStore.saveSession(sessionId, phoneNumber, 'connected');
                  sessionData.dbData = SessionStore.getSession(sessionId);

                  console.log(`✅ ${sessionId} force connected as ${phoneNumber}`);
                  io.emit('ready', { sessionId, phoneNumber });
                  broadcastSessions();
                } else {
                  console.log(`⚠️ Client info not available yet, will retry in 30s...`);
                }
              }
            } catch (err) {
              console.error(`❌ Error force checking client state: ${err.message}`);
            }
          }
        }, 15000); // 15 seconds after first auth

        // Fallback: longer timeout
        setTimeout(async () => {
          if (!sessionData.status.isLoggedIn) {
            console.log(`⚠️ Ready event didn't fire for ${sessionId} after 60s, final attempt...`);

            try {
              // Try to manually get client info
              if (client && client.info && client.info.wid) {
                const phoneNumber = client.info.wid.user;
                console.log(`✅ Final attempt - retrieved client info: ${phoneNumber}`);

                sessionData.status = {
                  status: 'CONNECTED',
                  isLoggedIn: true,
                  number: phoneNumber,
                  connectedAt: new Date()
                };
                sessionData.qrCode = null;
                sessionData.client = client;

                // Save to JSON
                SessionStore.saveSession(sessionId, phoneNumber, 'connected');
                sessionData.dbData = SessionStore.getSession(sessionId);

                console.log(`✅ ${sessionId} manually connected as ${phoneNumber}`);
                io.emit('ready', { sessionId, phoneNumber });
                broadcastSessions();
              } else {
                console.log(`❌ Client ${sessionId} is still not ready after 60s. Try restarting the session.`);
              }
            } catch (err) {
              console.error(`❌ Error checking client state: ${err.message}`);
            }
          }
        }, 60000); // 60 seconds
      }
    });

    // Loading screen event - helpful for debugging
    client.on('loading_screen', (percent, message) => {
      console.log(`⏳ Loading ${sessionId}: ${percent}% - ${message}`);
    });

    // Change event - sometimes fires when ready doesn't
    client.on('change_state', (state) => {
      console.log(`🔄 State change for ${sessionId}: ${state}`);

      // If state is CONNECTED but ready event didn't fire
      if (state === 'CONNECTED' && !sessionData.status.isLoggedIn) {
        console.log(`⚠️ State is CONNECTED but ready event didn't fire. Attempting manual connection...`);

        setTimeout(async () => {
          try {
            if (client && client.info && client.info.wid) {
              const phoneNumber = client.info.wid.user;
              console.log(`✅ Retrieved client info from change_state: ${phoneNumber}`);

              sessionData.status = {
                status: 'CONNECTED',
                isLoggedIn: true,
                number: phoneNumber,
                connectedAt: new Date()
              };
              sessionData.qrCode = null;
              sessionData.client = client;

              // Save to JSON
              SessionStore.saveSession(sessionId, phoneNumber, 'connected');
              sessionData.dbData = SessionStore.getSession(sessionId);

              console.log(`✅ ${sessionId} connected as ${phoneNumber} via change_state`);
              io.emit('ready', { sessionId, phoneNumber });
              broadcastSessions();
            }
          } catch (err) {
            console.error(`❌ Error in change_state handler: ${err.message}`);
          }
        }, 5000); // Wait 5 seconds to let everything stabilize
      }
    });

    // Auth failure event
    client.on('auth_failure', (msg) => {
      console.error(`❌ Auth failure for ${sessionId}: ${msg}`);
      sessionData.status = {
        status: 'AUTH_FAILURE',
        isLoggedIn: false,
        number: null,
        error: msg
      };
      broadcastSessions();
    });

    // Disconnected event
    client.on('disconnected', async (reason) => {
      console.log(`📴 Client ${sessionId} disconnected: ${reason}`);

      // Clean up puppeteer page to prevent memory leak
      if (client.pupPage) {
        try {
          await client.pupPage.close();
          console.log(`✅ Closed puppeteer page for ${sessionId}`);
        } catch (e) {
          console.log(`⚠️ Could not close puppeteer page: ${e.message}`);
        }
      }

      sessionData.status = {
        status: 'DISCONNECTED',
        isLoggedIn: false,
        number: null,
        reason: reason,
        disconnectedAt: Date.now() // Track when disconnected for cleanup
      };
      sessionData.client = null;
      broadcastSessions();
    });

    // ========== MESSAGE HANDLER - AUTO-REPLIES & AI ==========
    // NOTE: This handler ONLY processes INCOMING messages for auto-replies.
    // Manual messages sent via /send-message API are NOT affected by this logic.
    client.on('message', async (message) => {
      // Only process incoming messages (not sent by us)
      if (message.fromMe) return;

      const text = message.body || '';
      const senderJid = message.from;
      const phone = senderJid.replace(/@c\.us|@s\.whatsapp\.net|@g\.us/g, '');

      // IMPORTANT: Reload session data from JSON to get latest settings (AI mode, OT, etc.)
      sessionData.dbData = SessionStore.getSession(sessionId) || {};
      const dbData = sessionData.dbData;

      // Skip group messages for AI mode (only respond to direct messages)
      const isGroup = senderJid.endsWith('@g.us');

      console.log(`📩 [${sessionId}] Message from ${phone}: ${text.substring(0, 50)}...`);
      console.log(`📍 [${sessionId}] Sender JID: ${senderJid} | Phone extracted: ${phone}`);
      console.log(`🔧 [${sessionId}] AI Mode: ${dbData.ai_mode_enabled ? 'ENABLED' : 'DISABLED'}, OT Mode: ${dbData.ot_message_enabled ? 'ENABLED' : 'DISABLED'}`);

      // AI MODE - Auto-reply with AI chatbot (only for direct messages)
      // IMPORTANT: AI responses are sent IMMEDIATELY from the SAME session that received the message
      // - No queue: Messages bypass the queue system entirely
      // - No rate limits: AI can respond instantly without 1-minute delay
      // - Same session: Reply is sent from the same WhatsApp number that received it
      if (dbData && dbData.ai_mode_enabled && !isGroup && text.trim()) {
        console.log(`🤖 AI Mode: Message from ${phone} on ${sessionId}`);

        try {
          // Wait longer for WhatsApp Web to fully synchronize the chat state
          console.log(`⏳ Waiting for chat sync...`);
          await new Promise(resolve => setTimeout(resolve, 3000));

          // Skip sendSeen as it's causing sync issues
          // The message.reply() method will handle this automatically

          // Simulate typing delay
          console.log(`⌨️ Simulating typing...`);
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Get AI response
          const aiResponse = await getAIResponse(text, phone);

          // Simulate typing delay based on response length
          const typingDelay = Math.min(3000, aiResponse.length * 30); // 30ms per character, max 3s
          await new Promise(resolve => setTimeout(resolve, typingDelay));

          // Send directly from this session (bypasses queue and rate limits)
          console.log(`📤 Sending AI response to ${senderJid} (phone: ${phone})`);
          console.log(`📝 Response preview: ${aiResponse.substring(0, 100)}...`);

          try {
            // Use sendSeen: false to skip the problematic sendSeen call that causes markedUnread error
            await client.sendMessage(senderJid, aiResponse, { sendSeen: false });
            console.log(`✅ AI response sent successfully to ${phone} from ${sessionId}`);
          } catch (sendError) {
            console.error(`❌ Send failed:`, sendError.message);

            // Fallback: Try direct puppeteer send
            try {
              console.log(`🔄 Attempting direct puppeteer send...`);
              await sendMessageDirect(client, senderJid, aiResponse);
              console.log(`✅ AI response sent via puppeteer to ${phone}`);
            } catch (directError) {
              console.error(`❌ Direct send also failed:`, directError.message);
              throw directError;
            }
          }
        } catch (err) {
          console.error(`❌ AI error:`, err.message);
          console.error(`❌ Full error:`, err);
        }

        // Skip other auto-replies if AI mode handled the message
        return;
      }

      // OT AUTO-REPLY - Only if this session has ot_message_enabled
      if (text.trim().toUpperCase() === 'OT') {
        if (dbData && dbData.ot_message_enabled) {
          console.log(`📩 OT request on ${sessionId} (enabled)`);

          try {
            await new Promise(resolve => setTimeout(resolve, 1500));

            const reply = `Hello! Your OT request has been received.\n\n` +
              `This is an automated response from ${sessionData.status.number}.\n\n` +
              `Your overtime details will be sent to you shortly.`;

            try {
              // Use sendSeen: false to skip the problematic sendSeen call
              await client.sendMessage(senderJid, reply, { sendSeen: false });
              console.log(`✅ OT response sent to ${phone}`);
            } catch (sendError) {
              console.error(`❌ Send failed for OT:`, sendError.message);
              // Try direct puppeteer send as fallback
              try {
                await sendMessageDirect(client, senderJid, reply);
                console.log(`✅ OT response sent via puppeteer to ${phone}`);
              } catch (directError) {
                console.error(`❌ Direct send also failed for OT:`, directError.message);
                throw directError;
              }
            }
          } catch (err) {
            console.error(`❌ OT error:`, err.message);
          }
        } else {
          console.log(`⚠️ OT request on ${sessionId} but NOT enabled`);
        }
      }
    });

    // Initialize the client
    console.log(`🚀 Initializing client ${sessionId}...`);
    sessionData.status = {
      status: 'INITIALIZING',
      isLoggedIn: false,
      number: null
    };
    broadcastSessions();

    await client.initialize();

    // Set up browser console listener after initialization
    if (client.pupPage) {
      client.pupPage.on('console', msg => {
        const text = msg.text();
        if (text.includes('[Browser]')) {
          console.log(`🌐 ${text}`);
        }
      });
    }

    return client;

  } catch (err) {
    console.error(`❌ Failed to create client for ${sessionId}:`, err.message);
    sessionData.status = {
      status: 'ERROR',
      isLoggedIn: false,
      number: null,
      error: err.message
    };
    broadcastSessions();
    throw err;
  }
}

// Direct message send via puppeteer - bypasses sendSeen issue in whatsapp-web.js
async function sendMessageDirect(client, chatId, messageText) {
  try {
    const page = client.pupPage;
    if (!page) {
      throw new Error('Puppeteer page not available');
    }

    // Use WhatsApp Web's internal messaging API
    const result = await page.evaluate(async (chatId, messageText) => {
      try {
        // Get the WWebJS module which should be injected by whatsapp-web.js
        const WWebJS = window.WWebJS;

        // First ensure the chat exists - find or create it
        let chatWid;
        if (window.Store && window.Store.WidFactory) {
          chatWid = window.Store.WidFactory.createWid(chatId);
        }

        // Find the chat
        let chat;
        if (window.Store && window.Store.Chat) {
          chat = window.Store.Chat.get(chatId) ||
                 (chatWid ? window.Store.Chat.get(chatWid) : null);

          // If chat not found, try to find by user
          if (!chat) {
            const models = window.Store.Chat.getModelsArray ?
                          window.Store.Chat.getModelsArray() :
                          Array.from(window.Store.Chat.models || []);
            const phone = chatId.replace(/@.*/, '');
            chat = models.find(c => c.id && (c.id.user === phone || c.id._serialized === chatId));
          }
        }

        if (!chat) {
          // Try to open/create chat with this contact
          if (window.Store && window.Store.Chat && window.Store.Chat.find) {
            chat = await window.Store.Chat.find(chatWid || chatId);
          }
        }

        if (!chat) {
          return { success: false, error: `Chat not found: ${chatId}` };
        }

        // Collect all errors for debugging
        const errors = [];

        // Try different send methods based on what's available in debug
        // Method 1: Try using window.WWebJS which is injected by whatsapp-web.js
        if (window.WWebJS && window.WWebJS.sendMessage) {
          try {
            await window.WWebJS.sendMessage(chat, messageText, { sendSeen: false });
            return { success: true, method: 'WWebJS.sendMessage' };
          } catch (e) {
            errors.push({ method: 'WWebJS.sendMessage', error: e.message || String(e) });
          }
        }

        // Method 2: Try creating and sending message with Store.addAndSendMsgToChat
        if (window.Store && window.Store.addAndSendMsgToChat) {
          try {
            await window.Store.addAndSendMsgToChat(chat, messageText);
            return { success: true, method: 'Store.addAndSendMsgToChat' };
          } catch (e) {
            errors.push({ method: 'addAndSendMsgToChat', error: e.message || String(e) });
          }
        }

        // Method 3: Try SendTextMsgToChat which is commonly available
        if (window.Store && window.Store.SendTextMsgToChat) {
          try {
            await window.Store.SendTextMsgToChat(chat, messageText);
            return { success: true, method: 'Store.SendTextMsgToChat' };
          } catch (e) {
            errors.push({ method: 'SendTextMsgToChat', error: e.message || String(e) });
          }
        }

        // Method 4: Try using chat.sendMessage directly (what failed before)
        if (chat && chat.sendMessage) {
          try {
            await chat.sendMessage(messageText);
            return { success: true, method: 'chat.sendMessage' };
          } catch (e) {
            errors.push({ method: 'chat.sendMessage', error: e.message || String(e) });
          }
        }

        return { success: false, error: 'All send methods failed', details: errors };
      } catch (err) {
        return { success: false, error: err.message || String(err) };
      }
    }, chatId, messageText);

    if (!result.success) {
      // Log detailed error information
      if (result.details && result.details.length > 0) {
        console.error('📊 Detailed send errors:', JSON.stringify(result.details, null, 2));
      }
      throw new Error(result.error || 'Unknown error sending message');
    }

    console.log(`✅ Message sent via puppeteer (${result.method}) to ${chatId}`);
    return true;
  } catch (error) {
    console.error(`❌ Direct send error:`, error.message);
    throw error;
  }
}

// Send message safely - with LID fix for newer WhatsApp versions
async function sendMessageSafely(client, phone, message) {
  try {
    // Clean phone number - remove any non-numeric characters
    let cleanPhone = phone.replace(/[^0-9]/g, '');

    // Ensure country code is present (assume India if 10 digits)
    if (cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone;
    }

    console.log(`📤 Attempting to send to ${cleanPhone}...`);

    // Format as chatId
    const chatId = `${cleanPhone}@c.us`;

    // Method 1: Try to verify the number exists on WhatsApp (with timeout)
    let numberExists = true; // Assume exists by default
    try {
      console.log(`🔍 Checking if ${cleanPhone} is on WhatsApp...`);

      // Add a timeout wrapper for getNumberId
      const numberId = await Promise.race([
        client.getNumberId(chatId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('getNumberId timeout')), 10000)
        )
      ]);

      if (!numberId) {
        console.log(`❌ Number ${cleanPhone} does not exist on WhatsApp`);
        return false;
      }

      console.log(`✅ Number ${cleanPhone} exists on WhatsApp (${numberId._serialized})`);
    } catch (checkError) {
      // If check times out or fails, continue anyway and try to send
      console.log(`⚠️ Could not verify number (${checkError.message}), will try to send anyway...`);
      numberExists = true; // Proceed optimistically
    }

    // Method 2: Use WhatsApp Web URL to open chat and send message
    // This bypasses the need to create chat object - WhatsApp does it for us
    try {
      console.log(`🔄 Using WhatsApp Web URL method to create chat and send message...`);
      const page = client.pupPage;
      if (!page) {
        throw new Error('Puppeteer page not available');
      }

      // Navigate to the WhatsApp Web chat URL (this auto-creates the chat)
      const chatUrl = `https://web.whatsapp.com/send?phone=${cleanPhone}`;
      console.log(`📱 Opening chat URL: ${chatUrl}`);

      try {
        // Use domcontentloaded instead of networkidle2 for faster loading
        await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        console.log(`✅ Chat URL loaded`);

        // Wait for the message input box to appear (with shorter timeout)
        await page.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 8000 });
        console.log(`✅ Message input found`);

        // Type the message
        await page.type('div[contenteditable="true"][data-tab="10"]', message);
        console.log(`✅ Message typed`);

        // Wait a moment for typing to complete
        await new Promise(resolve => setTimeout(resolve, 300));

        // Press Enter to send
        await page.keyboard.press('Enter');
        console.log(`✅ Message sent via Enter key`);

        // Wait to ensure message is sent
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log(`✅ Message sent successfully to ${phone} via URL method`);
        return true;

      } catch (urlError) {
        console.error(`❌ URL method failed: ${urlError.message}`);
        console.log(`🔄 Falling back to direct injection method...`);

        // Fallback to the previous method
        const result = await page.evaluate(async (phoneNumber, messageText) => {
          try {
            const chatId = phoneNumber + '@c.us';

            // Step 1: Get or create contact
            let contact;
            if (window.Store && window.Store.Contact) {
              try {
                contact = await window.Store.Contact.find(chatId);
                if (!contact) {
                  return { success: false, error: 'Contact not found' };
                }
              } catch (e) {
                return { success: false, error: 'Contact.find failed: ' + e.message };
              }
            } else {
              return { success: false, error: 'Store.Contact not available' };
            }

            // Step 2: Get or create chat
            let chat = window.Store.Chat.get(chatId);

            // If chat doesn't exist, try multiple ways to create it
            if (!chat) {
              // Method A: Try openChatBottom on Store.Chat
              try {
                if (window.Store.Chat.openChatBottom) {
                  await window.Store.Chat.openChatBottom(contact);
                  await new Promise(resolve => setTimeout(resolve, 500));
                  chat = window.Store.Chat.get(chatId);
                }
              } catch (e) {
                // Continue to next method
              }
            }

            if (!chat) {
              // Method B: Try using Chat.find to create chat
              try {
                if (window.Store.Chat.find) {
                  chat = await window.Store.Chat.find(chatId);
                }
              } catch (e) {
                // Continue
              }
            }

            if (!chat) {
              // Method C: Try to create chat by opening it via contact
              try {
                if (contact.openChat) {
                  await contact.openChat();
                  await new Promise(resolve => setTimeout(resolve, 500));
                  chat = window.Store.Chat.get(chatId);
                }
              } catch (e) {
                // Continue
              }
            }

            // If still no chat, try alternative methods to force-create it
            if (!chat) {
              // Method D: Try using WWebJS.getChat which might create the chat
              try {
                if (window.WWebJS && window.WWebJS.getChat) {
                  chat = await window.WWebJS.getChat(chatId);
                  if (chat) {
                    // Success! Now chat exists, continue to send methods below
                  }
                }
              } catch (e) {
                // Continue
              }
            }

            if (!chat) {
              // Method E: Last resort - try to create empty chat model
              try {
                if (window.Store && window.Store.Chat && window.Store.Chat.gadd) {
                  const chatData = {
                    id: chatId,
                    conversationTimestamp: Date.now()
                  };
                  chat = await window.Store.Chat.gadd(chatData, { merge: true });
                }
              } catch (e) {
                // Continue
              }
            }

            // If absolutely no chat can be created, return error
            if (!chat) {
              return { success: false, error: 'Could not create chat after all methods' };
            }

            // Step 3: Now try different send methods with the opened chat

            // Method 1: Try the most direct approach - use WWebJS getChat then sendMessage
            if (window.WWebJS && window.WWebJS.getChat) {
              try {
                const wwebChat = await window.WWebJS.getChat(chatId);
                if (wwebChat && wwebChat.sendMessage) {
                  await wwebChat.sendMessage(messageText);
                  return { success: true, method: 'WWebJS.getChat().sendMessage()' };
                }
              } catch (e) {
                console.log('WWebJS.getChat().sendMessage failed:', e.message);
              }
            }

            // Method 2: Use WWebJS.sendMessage directly with chatId string
            if (window.WWebJS && window.WWebJS.sendMessage) {
              try {
                // Try passing chatId instead of chat object
                await window.WWebJS.sendMessage(chatId, messageText, { sendSeen: false });
                return { success: true, method: 'WWebJS.sendMessage with chatId' };
              } catch (e) {
                console.log('WWebJS.sendMessage with chatId failed:', e.message);
              }
            }

            // Method 3: Use Store.SendMessage if it exists
            if (window.Store && window.Store.SendMessage && typeof window.Store.SendMessage === 'function') {
              try {
                await window.Store.SendMessage(chat, messageText);
                return { success: true, method: 'Store.SendMessage' };
              } catch (e) {
                console.log('Store.SendMessage failed:', e.message);
              }
            }

            // Method 3: Use Store.Msg to compose and send
            if (window.Store && window.Store.Msg && window.Store.Msg.createMsgRecord) {
              try {
                const msgRecord = await window.Store.Msg.createMsgRecord({ body: messageText, type: 'chat' });
                await window.Store.SendMessage(chat, msgRecord);
                return { success: true, method: 'Store.Msg.createMsgRecord' };
              } catch (e) {
                console.log('Store.Msg.createMsgRecord failed:', e.message);
              }
            }

            // Method 4: Use chat.sendMessage if available
            if (chat && typeof chat.sendMessage === 'function') {
              try {
                await chat.sendMessage(messageText);
                return { success: true, method: 'chat.sendMessage' };
              } catch (e) {
                console.log('chat.sendMessage failed:', e.message);
              }
            }

            // Debug: Log available methods
            const storeMethods = window.Store ? Object.keys(window.Store).filter(k =>
              k.toLowerCase().includes('send') || k.toLowerCase().includes('msg')
            ) : [];
            const chatMethods = chat ? Object.keys(chat).filter(k => typeof chat[k] === 'function') : [];

            return {
              success: false,
              error: 'All send methods failed',
              debug: {
                storeMethods: storeMethods.slice(0, 30),
                chatMethods: chatMethods.slice(0, 30),
                hasWWebJS: !!window.WWebJS,
                hasStore: !!window.Store
              }
            };
          } catch (err) {
            return { success: false, error: err.message || String(err) };
          }
        }, cleanPhone, message);

        if (result.success) {
          console.log(`✅ Message sent to ${phone} via ${result.method}`);
          return true;
        }

        console.error(`❌ All send methods failed for ${phone}: ${result.error}`);
        if (result.debug) {
          console.log(`📊 Debug info:`, JSON.stringify(result.debug, null, 2));
        }
        return false;
      }
    } catch (getNumberIdError) {
      console.error(`❌ getNumberId failed for ${phone}:`, getNumberIdError.message);
      return false;
    }
  } catch (error) {
    console.error(`❌ Failed to send to ${phone}:`, error.message);
    return false;
  }
}

// Process message queue
async function processMessageQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;

  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const job = messageQueue.shift();

    try {
      // Delay between messages (3-5 seconds)
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

      const session = getNextSession();
      if (!session) {
        job.reject(new Error('No connected sessions'));
        continue;
      }

      let success = false;

      if (job.type === 'text') {
        success = await sendMessageSafely(session.client, job.phone, job.message);
      }

      if (success) {
        job.resolve({
          status: 'success',
          sentFrom: session.status.number,
          sessionId: session.sessionId
        });
      } else {
        job.reject(new Error('Failed to send'));
      }

    } catch (error) {
      job.reject(error);
    }
  }

  isProcessingQueue = false;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 Client connected');
  broadcastSessions();

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected');
  });
});

// API Routes

// Start new session
app.post('/start-session', async (req, res) => {
  try {
    const sessionId = generateSessionId();
    console.log(`🚀 Starting new session: ${sessionId}`);

    // Save to JSON
    SessionStore.saveSession(sessionId, null, 'connecting');

    // Don't await - let it run in background
    createClient(sessionId).catch(err => {
      console.error(`Session creation error: ${err.message}`);
    });

    res.json({ status: 'initialized', sessionId });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get all sessions
app.get('/sessions', async (req, res) => {
  try {
    const jsonSessions = SessionStore.getAllSessions();

    const list = jsonSessions.map(db => {
      const runtime = sessions.get(db.session_id);
      const usage = sessionUsage.get(db.session_id);

      // Calculate usage stats
      let usageStats = null;
      if (usage) {
        const now = Date.now();
        const nextAllowedTime = usage.nextAllowedTime || now;
        const secondsUntilNext = Math.max(0, Math.ceil((nextAllowedTime - now) / 1000));

        usageStats = {
          hourlyCount: usage.hourlyCount || 0,
          hourlyLimit: ANTI_BAN.MAX_MESSAGES_PER_HOUR,
          consecutiveMessages: usage.consecutiveMessages || 0,
          onBreak: usage.onBreak || false,
          breakEndTime: usage.breakEndTime,
          secondsUntilNextMessage: secondsUntilNext,
          nextMessageTime: nextAllowedTime > now ? new Date(nextAllowedTime).toISOString() : null
        };
      }

      const assignmentData = {
        ot_message_enabled: Boolean(db.ot_message_enabled),
        checkin_checkout_enabled: Boolean(db.checkin_checkout_enabled),
        group_message_enabled: Boolean(db.group_message_enabled),
        pc_automation_enabled: Boolean(db.pc_automation_enabled),
        delegation_enabled: Boolean(db.delegation_enabled),
        helpticket_enabled: Boolean(db.helpticket_enabled),
        ai_mode_enabled: Boolean(db.ai_mode_enabled),
        ncr_enabled: Boolean(db.ncr_enabled)
      };

      return {
        sessionId: db.session_id,
        phoneNumber: db.phone_number,
        status: runtime ? runtime.status : { status: db.status, isLoggedIn: false },
        hasQR: runtime ? !!runtime.qrCode : false,
        createdAt: runtime ? runtime.createdAt : db.created_at,
        assignments: assignmentData,
        dbData: assignmentData,  // Also include as dbData for backward compatibility
        usageStats: usageStats
      };
    });

    res.json({ sessions: list });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get QR code for session
app.get('/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ message: 'Session not found' });
  }

  if (!session.qrCode) {
    return res.status(404).json({ message: 'QR code not available' });
  }

  res.json({ qrCode: session.qrCode });
});

// Send message - DISABLED: Use /send-flag-message instead
// All messages must be sent with a valid flag for proper session routing and rate limiting
app.post('/send-message', async (req, res) => {
  return res.status(403).json({
    status: 'error',
    message: 'Direct messaging is disabled. Use /send-flag-message with a valid flag instead.',
    validFlags: ['ot_message', 'checkin_checkout', 'group_message', 'pc_automation', 'delegation', 'helpticket', 'ai_mode', 'ncr'],
    example: {
      flag: 'checkin_checkout',
      phone: '919876543210',
      message: 'Your message here'
    }
  });
});

// ========== FLAG-BASED MESSAGE SENDING WITH RATE LIMITING ==========

// Get random delay between 2-3 minutes (in milliseconds)
function getFlagMessageDelay() {
  const minDelay = 2 * 60 * 1000; // 2 minutes
  const maxDelay = 3 * 60 * 1000; // 3 minutes
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Check if session can send message (rate limit check)
function canSessionSendMessage(sessionId) {
  const rateLimit = sessionRateLimits.get(sessionId);
  if (!rateLimit) {
    return { canSend: true, waitTime: 0 };
  }

  const now = Date.now();
  if (now >= rateLimit.nextAllowedTime) {
    return { canSend: true, waitTime: 0 };
  }

  const waitTime = rateLimit.nextAllowedTime - now;
  return { canSend: false, waitTime };
}

// Update session rate limit after sending
function updateSessionRateLimit(sessionId) {
  const now = Date.now();
  const delay = getFlagMessageDelay();
  sessionRateLimits.set(sessionId, {
    lastMessageTime: now,
    nextAllowedTime: now + delay,
    delayMs: delay
  });
  console.log(`⏱️ Session ${sessionId} rate limit set: next message allowed in ${Math.round(delay / 1000)}s`);
}

// Get best available session for a flag (one with shortest wait time)
function getBestSessionForFlag(flag) {
  const flagToField = {
    'ot_message': 'ot_message_enabled',
    'checkin_checkout': 'checkin_checkout_enabled',
    'group_message': 'group_message_enabled',
    'pc_automation': 'pc_automation_enabled',
    'delegation': 'delegation_enabled',
    'helpticket': 'helpticket_enabled',
    'ai_mode': 'ai_mode_enabled',
    'ncr': 'ncr_enabled'
  };

  const field = flagToField[flag];
  if (!field) {
    console.log(`❌ Unknown flag: ${flag}`);
    return null;
  }

  // Get all connected sessions with this flag enabled
  const eligibleSessions = [];

  for (const [sessionId, sessionData] of sessions.entries()) {
    if (!sessionData.client || !sessionData.status.isLoggedIn) continue;

    // Get fresh data from JSON
    const dbData = SessionStore.getSession(sessionId) || {};
    if (!dbData[field]) continue;

    const { canSend, waitTime } = canSessionSendMessage(sessionId);
    eligibleSessions.push({
      sessionId,
      sessionData,
      canSend,
      waitTime
    });
  }

  if (eligibleSessions.length === 0) {
    console.log(`❌ No sessions with flag ${flag} enabled and connected`);
    return null;
  }

  // Sort by wait time (sessions that can send now first, then by shortest wait)
  eligibleSessions.sort((a, b) => {
    if (a.canSend && !b.canSend) return -1;
    if (!a.canSend && b.canSend) return 1;
    return a.waitTime - b.waitTime;
  });

  const best = eligibleSessions[0];
  console.log(`✅ Best session for flag ${flag}: ${best.sessionId} (canSend: ${best.canSend}, waitTime: ${Math.round(best.waitTime / 1000)}s)`);

  return best;
}

// Process flag message queue
async function processFlagMessageQueue() {
  if (isFlagQueueProcessing || flagMessageQueue.length === 0) return;

  isFlagQueueProcessing = true;
  console.log(`\n🚀 Processing flag message queue (${flagMessageQueue.length} messages)`);

  while (flagMessageQueue.length > 0) {
    const job = flagMessageQueue[0]; // Peek at first job

    const bestSession = getBestSessionForFlag(job.flag);

    if (!bestSession) {
      // No eligible session, reject the job
      flagMessageQueue.shift();
      job.reject(new Error(`No connected sessions with flag ${job.flag} enabled`));
      continue;
    }

    if (!bestSession.canSend) {
      // Need to wait - don't remove from queue yet
      const waitMs = bestSession.waitTime;
      console.log(`⏳ Waiting ${Math.round(waitMs / 1000)}s for session ${bestSession.sessionId}...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    // Now we can send
    flagMessageQueue.shift(); // Remove from queue

    try {
      const success = await sendMessageSafely(bestSession.sessionData.client, job.phone, job.message);

      if (success) {
        // Update rate limit for this session
        updateSessionRateLimit(bestSession.sessionId);

        job.resolve({
          status: 'success',
          sentFrom: bestSession.sessionData.status.number,
          sessionId: bestSession.sessionId,
          flag: job.flag
        });
        console.log(`✅ Flag message sent: ${job.flag} -> ${job.phone} via ${bestSession.sessionId}`);
      } else {
        job.reject(new Error('Failed to send message'));
      }
    } catch (error) {
      console.error(`❌ Error sending flag message:`, error.message);
      job.reject(error);
    }
  }

  isFlagQueueProcessing = false;
  console.log(`✅ Flag message queue processing complete\n`);
}

// API: Send message with flag-based routing and rate limiting
app.post('/send-flag-message', async (req, res) => {
  try {
    const { flag, phone, phones, message } = req.body;

    // Validate flag
    const validFlags = ['ot_message', 'checkin_checkout', 'group_message', 'pc_automation',
                        'delegation', 'helpticket', 'ai_mode', 'ncr'];

    if (!flag || !validFlags.includes(flag)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid or missing flag. Valid flags: ${validFlags.join(', ')}`
      });
    }

    if (!message) {
      return res.status(400).json({ status: 'error', message: 'Message is required' });
    }

    const targetPhones = phones || (phone ? [phone] : []);

    if (targetPhones.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Phone number(s) required' });
    }

    // Check if any session has this flag enabled
    const flagToField = {
      'ot_message': 'ot_message_enabled',
      'checkin_checkout': 'checkin_checkout_enabled',
      'group_message': 'group_message_enabled',
      'pc_automation': 'pc_automation_enabled',
      'delegation': 'delegation_enabled',
      'helpticket': 'helpticket_enabled',
      'ai_mode': 'ai_mode_enabled',
      'ncr': 'ncr_enabled'
    };

    // Check runtime sessions for this flag
    let hasEnabledSession = false;
    for (const [sessionId, sessionData] of sessions.entries()) {
      if (!sessionData.client || !sessionData.status.isLoggedIn) continue;
      const dbData = SessionStore.getSession(sessionId) || {};
      if (dbData[flagToField[flag]]) {
        hasEnabledSession = true;
        break;
      }
    }

    if (!hasEnabledSession) {
      return res.status(400).json({
        status: 'error',
        message: `No connected sessions have ${flag} enabled`
      });
    }

    console.log(`\n📨 Flag message request: flag=${flag}, phones=${targetPhones.length}, message=${message.substring(0, 50)}...`);

    const results = [];

    for (const targetPhone of targetPhones) {
      // Check queue size before adding
      if (flagMessageQueue.length >= MAX_FLAG_QUEUE_SIZE) {
        results.push(Promise.reject(new Error('Message queue is full. Please try again later.')));
        continue;
      }

      const promise = new Promise((resolve, reject) => {
        flagMessageQueue.push({
          flag,
          phone: targetPhone,
          message,
          resolve,
          reject,
          addedAt: Date.now()
        });
      });

      results.push(promise);
    }

    // Start processing
    processFlagMessageQueue();

    // Wait for all to complete
    const outcomes = await Promise.allSettled(results);

    res.json({
      status: 'completed',
      flag,
      results: outcomes.map((outcome, i) => ({
        phone: targetPhones[i],
        status: outcome.status,
        result: outcome.status === 'fulfilled' ? outcome.value : outcome.reason?.message
      }))
    });

  } catch (error) {
    console.error('❌ Flag message error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// API: Get rate limit status for all sessions
app.get('/rate-limits', (_req, res) => {
  const limits = [];
  const now = Date.now();

  for (const [sessionId, sessionData] of sessions.entries()) {
    if (!sessionData.status.isLoggedIn) continue;

    const rateLimit = sessionRateLimits.get(sessionId);
    const dbData = SessionStore.getSession(sessionId) || {};

    limits.push({
      sessionId,
      phoneNumber: sessionData.status.number,
      rateLimit: rateLimit ? {
        lastMessageTime: new Date(rateLimit.lastMessageTime).toISOString(),
        nextAllowedTime: new Date(rateLimit.nextAllowedTime).toISOString(),
        canSendNow: now >= rateLimit.nextAllowedTime,
        waitTimeSeconds: Math.max(0, Math.ceil((rateLimit.nextAllowedTime - now) / 1000))
      } : {
        canSendNow: true,
        waitTimeSeconds: 0
      },
      enabledFlags: {
        ot_message: dbData.ot_message_enabled,
        checkin_checkout: dbData.checkin_checkout_enabled,
        group_message: dbData.group_message_enabled,
        pc_automation: dbData.pc_automation_enabled,
        delegation: dbData.delegation_enabled,
        helpticket: dbData.helpticket_enabled,
        ai_mode: dbData.ai_mode_enabled,
        ncr: dbData.ncr_enabled
      }
    });
  }

  res.json({
    status: 'success',
    queueLength: flagMessageQueue.length,
    sessions: limits
  });
});

// Logout session
app.post('/logout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }

    // First destroy the client (this triggers logout internally)
    if (session.client) {
      try {
        await session.client.destroy();
        console.log(`✅ Client destroyed for ${sessionId}`);
      } catch (e) {
        console.error(`Destroy error: ${e.message}`);
      }
    }

    sessions.delete(sessionId);
    sessionUsage.delete(sessionId);

    // Delete from JSON storage
    SessionStore.deleteSession(sessionId);

    // Wait a bit for Windows to release file locks
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try to clean up the session folder with retry logic
    const sessionFolder = path.join(tokensDir, `session-${sessionId}`);
    let retries = 3;
    while (retries > 0) {
      try {
        if (fs.existsSync(sessionFolder)) {
          // Delete lockfile first if it exists
          const lockfilePath = path.join(sessionFolder, 'lockfile');
          if (fs.existsSync(lockfilePath)) {
            try {
              fs.unlinkSync(lockfilePath);
            } catch (e) {
              console.log(`Could not delete lockfile: ${e.message}`);
            }
          }

          // Wait a bit
          await new Promise(resolve => setTimeout(resolve, 500));

          // Try to delete the folder
          fs.rmSync(sessionFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
          console.log(`✅ Session folder deleted: ${sessionFolder}`);
          break;
        } else {
          break; // Folder doesn't exist, we're done
        }
      } catch (e) {
        retries--;
        console.log(`Failed to delete session folder (retries left: ${retries}): ${e.message}`);
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.warn(`⚠️ Could not delete session folder, will be cleaned up on next restart`);
        }
      }
    }

    broadcastSessions();
    res.json({ status: 'logged out', sessionId });
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Delete session
app.delete('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (session && session.client) {
      try {
        await session.client.destroy();
        console.log(`✅ Client destroyed for ${sessionId}`);
      } catch (e) {
        console.error(`Destroy error: ${e.message}`);
      }
    }

    sessions.delete(sessionId);
    sessionUsage.delete(sessionId);

    // Delete from JSON storage
    SessionStore.deleteSession(sessionId);

    // Wait a bit for Windows to release file locks
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try to clean up the session folder with retry logic
    const sessionFolder = path.join(tokensDir, `session-${sessionId}`);
    let retries = 3;
    while (retries > 0) {
      try {
        if (fs.existsSync(sessionFolder)) {
          // Delete lockfile first if it exists
          const lockfilePath = path.join(sessionFolder, 'lockfile');
          if (fs.existsSync(lockfilePath)) {
            try {
              fs.unlinkSync(lockfilePath);
            } catch (e) {
              console.log(`Could not delete lockfile: ${e.message}`);
            }
          }

          // Wait a bit
          await new Promise(resolve => setTimeout(resolve, 500));

          // Try to delete the folder
          fs.rmSync(sessionFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
          console.log(`✅ Session folder deleted: ${sessionFolder}`);
          break;
        } else {
          break; // Folder doesn't exist, we're done
        }
      } catch (e) {
        retries--;
        console.log(`Failed to delete session folder (retries left: ${retries}): ${e.message}`);
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.warn(`⚠️ Could not delete session folder, will be cleaned up on next restart`);
        }
      }
    }

    broadcastSessions();
    res.json({ status: 'deleted', sessionId });
  } catch (error) {
    console.error('❌ Delete error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Update session assignments
app.post('/session/:sessionId/assignments', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const assignments = req.body;

    console.log(`📝 Updating assignments for ${sessionId}:`, assignments);

    const updated = SessionStore.updateAssignments(sessionId, assignments);

    if (!updated) {
      console.log(`⚠️ Session ${sessionId} not found in sessions.json`);
      return res.status(404).json({ status: 'error', message: 'Session not found' });
    }

    // Reload JSON data in runtime
    const session = sessions.get(sessionId);
    if (session) {
      session.dbData = SessionStore.getSession(sessionId);
      console.log(`✅ Updated in-memory dbData for ${sessionId}`);
    } else {
      console.log(`⚠️ Session ${sessionId} not in runtime memory (Map), but JSON updated`);
    }

    broadcastSessions();

    res.json({ status: 'success', message: 'Assignments updated' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Clear AI conversation history for a specific user
app.post('/ai/clear-history/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    clearConversationHistory(phone);
    res.json({
      status: 'success',
      message: `Conversation history cleared for ${phone}`
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get AI conversation history stats
app.get('/ai/stats', (req, res) => {
  try {
    const stats = ChatMemoryStore.getStats();

    res.json({
      status: 'success',
      stats: stats
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get conversation details for a specific user
app.get('/ai/conversation/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    const conversation = ChatMemoryStore.getConversation(phone);

    res.json({
      status: 'success',
      phone: phone,
      messageCount: conversation.length,
      messages: conversation
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Clear all AI conversation history
app.post('/ai/clear-all-history', (req, res) => {
  try {
    ChatMemoryStore.clearAllHistory();
    res.json({
      status: 'success',
      message: 'All conversation history cleared'
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Cleanup old AI conversations
app.post('/ai/cleanup', (req, res) => {
  try {
    const { days } = req.body;
    const olderThan = days || 7; // Default 7 days
    const deleted = ChatMemoryStore.cleanup(olderThan);

    res.json({
      status: 'success',
      message: `Cleaned up ${deleted} old conversations (older than ${olderThan} days)`
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Test database connection
app.get('/db/test', async (req, res) => {
  try {
    const isConnected = await DatabaseHelper.testConnection();
    res.json({
      status: 'success',
      connected: isConnected,
      message: isConnected ? 'Database connected successfully' : 'Database connection failed'
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get order status by order number
app.get('/db/order/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const result = await DatabaseHelper.getOrderStatus(orderNumber);

    if (result.found) {
      res.json({
        status: 'success',
        found: true,
        order: result
      });
    } else {
      res.json({
        status: 'success',
        found: false,
        message: result.message
      });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get table structure (for debugging)
app.get('/db/structure', async (req, res) => {
  try {
    const structure = await DatabaseHelper.getTableStructure();
    res.json({
      status: 'success',
      structure: structure
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get sample orders (for debugging)
app.get('/db/sample', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const samples = await DatabaseHelper.getSampleOrders(limit);
    res.json({
      status: 'success',
      count: samples.length,
      samples: samples
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Test send methods endpoint
app.post('/test-send-methods', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ status: 'error', message: 'Phone number required' });
    }

    // Get first connected session
    const sessionData = Array.from(sessions.values()).find(s => s.status.isLoggedIn);
    if (!sessionData || !sessionData.client) {
      return res.status(400).json({ status: 'error', message: 'No connected session found' });
    }

    const client = sessionData.client;
    const chatId = phone.replace(/[^0-9]/g, '') + '@c.us';
    const testMessage = 'Test from method testing';

    console.log(`🧪 Testing all send methods for ${chatId}...`);

    const page = client.pupPage;
    if (!page) {
      return res.status(500).json({ status: 'error', message: 'Puppeteer page not available' });
    }

    const results = await page.evaluate(async (chatId, messageText) => {
      const results = [];

      // Get or create chat
      let chat;
      let contact;

      // Try to get existing chat first
      if (window.Store && window.Store.Chat) {
        chat = window.Store.Chat.get(chatId);
        results.push({ method: 'Chat.get', status: chat ? 'Found existing chat' : 'No existing chat' });
      }

      // Find the contact
      if (window.Store && window.Store.Contact) {
        try {
          contact = await window.Store.Contact.find(chatId);
          if (contact) {
            results.push({ method: 'Contact.find', status: 'SUCCESS', contact: contact.id._serialized });
          }
        } catch (e) {
          results.push({ method: 'Contact.find', error: e.message });
        }
      }

      // If no chat exists, try to open/create it
      if (!chat && contact) {
        try {
          // Try openChatBottom to open chat UI
          if (window.Store.Chat && window.Store.Chat.openChatBottom) {
            await window.Store.Chat.openChatBottom(contact);
            results.push({ method: 'Chat.openChatBottom', status: 'Called' });
            // Now try to get the chat again
            chat = window.Store.Chat.get(chatId);
            results.push({ method: 'Chat.get after openChatBottom', status: chat ? 'SUCCESS' : 'FAILED' });
          }
        } catch (e) {
          results.push({ method: 'Chat.openChatBottom', error: e.message });
        }
      }

      // If still no chat, try alternative methods
      if (!chat && window.Store && window.Store.Chat && window.Store.Chat.find) {
        try {
          chat = await window.Store.Chat.find(chatId);
          results.push({ method: 'Chat.find', status: chat ? 'SUCCESS' : 'FAILED' });
        } catch (e) {
          results.push({ method: 'Chat.find', error: e.message });
        }
      }

      if (!chat) {
        return { error: 'Could not get or create chat object', results };
      }

      // Method 1: WWebJS.sendMessage
      if (window.WWebJS && window.WWebJS.sendMessage) {
        try {
          await window.WWebJS.sendMessage(chat, messageText, { sendSeen: false });
          results.push({ method: 'WWebJS.sendMessage', status: 'SUCCESS' });
          return { success: true, workingMethod: 'WWebJS.sendMessage', results };
        } catch (e) {
          results.push({ method: 'WWebJS.sendMessage', error: e.message });
        }
      } else {
        results.push({ method: 'WWebJS.sendMessage', error: 'Not available' });
      }

      // Method 2: Store.addAndSendMsgToChat
      if (window.Store && window.Store.addAndSendMsgToChat) {
        try {
          await window.Store.addAndSendMsgToChat(chat, messageText);
          results.push({ method: 'Store.addAndSendMsgToChat', status: 'SUCCESS' });
          return { success: true, workingMethod: 'Store.addAndSendMsgToChat', results };
        } catch (e) {
          results.push({ method: 'Store.addAndSendMsgToChat', error: e.message });
        }
      } else {
        results.push({ method: 'Store.addAndSendMsgToChat', error: 'Not available' });
      }

      // Method 3: Store.SendTextMsgToChat
      if (window.Store && window.Store.SendTextMsgToChat) {
        try {
          await window.Store.SendTextMsgToChat(chat, messageText);
          results.push({ method: 'Store.SendTextMsgToChat', status: 'SUCCESS' });
          return { success: true, workingMethod: 'Store.SendTextMsgToChat', results };
        } catch (e) {
          results.push({ method: 'Store.SendTextMsgToChat', error: e.message });
        }
      } else {
        results.push({ method: 'Store.SendTextMsgToChat', error: 'Not available' });
      }

      // Method 4: chat.sendMessage
      if (chat && chat.sendMessage) {
        try {
          await chat.sendMessage(messageText);
          results.push({ method: 'chat.sendMessage', status: 'SUCCESS' });
          return { success: true, workingMethod: 'chat.sendMessage', results };
        } catch (e) {
          results.push({ method: 'chat.sendMessage', error: e.message });
        }
      } else {
        results.push({ method: 'chat.sendMessage', error: 'Not available' });
      }

      // Method 5: Store.SendMessage - check what it actually is
      if (window.Store && window.Store.SendMessage) {
        try {
          // Check if it's a function or object
          const sendMsgType = typeof window.Store.SendMessage;
          results.push({ method: 'Store.SendMessage type', status: sendMsgType });

          if (sendMsgType === 'object') {
            // List available properties/methods
            const methods = Object.keys(window.Store.SendMessage);
            results.push({ method: 'Store.SendMessage methods', status: methods.join(', ') });
          }

          if (sendMsgType === 'function') {
            await window.Store.SendMessage(chat, messageText);
            results.push({ method: 'Store.SendMessage', status: 'SUCCESS' });
            return { success: true, workingMethod: 'Store.SendMessage', results };
          }
        } catch (e) {
          results.push({ method: 'Store.SendMessage', error: e.message });
        }
      } else {
        results.push({ method: 'Store.SendMessage', error: 'Not available' });
      }

      // Method 6: Try to get LID and retry WWebJS
      try {
        results.push({ method: 'Attempting LID fix', status: 'Starting...' });

        // Check if chat has lid
        results.push({ method: 'chat.lid', status: chat.lid ? 'Has LID: ' + chat.lid : 'No LID' });

        // Try to load chat to get LID
        if (!chat.lid && chat.loadEarlierMsgs) {
          await chat.loadEarlierMsgs();
          results.push({ method: 'loadEarlierMsgs', status: 'Called' });
        }

        // Try sending after loading
        if (window.WWebJS && window.WWebJS.sendMessage) {
          await window.WWebJS.sendMessage(chat, messageText, { sendSeen: false });
          results.push({ method: 'WWebJS.sendMessage after LID fix', status: 'SUCCESS' });
          return { success: true, workingMethod: 'WWebJS.sendMessage after LID fix', results };
        }
      } catch (e) {
        results.push({ method: 'LID fix attempt', error: e.message });
      }

      return { success: false, error: 'All methods failed', results };
    }, chatId, testMessage);

    console.log('🧪 Test results:', JSON.stringify(results, null, 2));
    res.json(results);

  } catch (error) {
    console.error('❌ Test error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  const connectedCount = Array.from(sessions.values())
    .filter(s => s.status.isLoggedIn).length;

  res.json({
    status: 'ok',
    totalSessions: sessions.size,
    connectedSessions: connectedCount,
    queueLength: QueueStore.getQueueLength()
  });
});

// Cleanup handlers
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function cleanup() {
  console.log('🧹 Cleaning up...');

  // Close all WhatsApp sessions
  for (const [, session] of sessions.entries()) {
    if (session.client) {
      try {
        await session.client.destroy();
      } catch (err) {
        console.error(err);
      }
    }
  }

  // Close database connections
  await DatabaseHelper.close();
  await SQLAgent.close();

  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
}

// Periodic cleanup (every 1 hour)
setInterval(() => {
  const deleted = QueueStore.cleanup();
  if (deleted > 0) {
    console.log(`🧹 Cleaned up ${deleted} old messages from queue`);
  }
}, 3600000); // 1 hour

// Periodic AI chat memory cleanup (every 24 hours)
setInterval(() => {
  const deleted = ChatMemoryStore.cleanup(7); // Clean conversations older than 7 days
  if (deleted > 0) {
    console.log(`🧹 Cleaned up ${deleted} old AI conversations`);
  }
}, 86400000); // 24 hours

// Restore previous sessions on startup
async function restoreSessions() {
  try {
    const savedSessions = SessionStore.getAllSessions();
    console.log(`\n🔄 Found ${savedSessions.length} saved session(s)`);

    if (savedSessions.length === 0) {
      console.log('✨ No previous sessions to restore\n');
      return;
    }

    // Only restore sessions that have a valid auth folder
    for (const session of savedSessions) {
      const sessionFolder = path.join(tokensDir, `session-${session.session_id}`);

      // Check if session folder exists (has saved authentication)
      if (fs.existsSync(sessionFolder)) {
        console.log(`♻️  Restoring session: ${session.session_id} (${session.phone_number || 'Unknown'})`);

        // Don't await - restore in background
        createClient(session.session_id).catch(err => {
          console.error(`❌ Failed to restore ${session.session_id}:`, err.message);
        });

        // Add small delay between restores to prevent overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.log(`⚠️  Skipping ${session.session_id} (no auth data found)`);
        // Update status to disconnected
        SessionStore.saveSession(session.session_id, session.phone_number, 'disconnected');
      }
    }

    console.log('✅ Session restoration complete\n');
  } catch (error) {
    console.error('❌ Error restoring sessions:', error);
  }
}

// Start server
server.listen(port, async () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🚀 WPP WhatsApp Server with AI & SQL Integration`);
  console.log(`${'='.repeat(70)}`);
  console.log(`🌐 Server: http://localhost:${port}`);
  console.log(`📁 Tokens: ${tokensDir}`);
  console.log(`💾 Storage: sessions.json, message_queue.json & chat_memory.json`);
  console.log(`\n🎯 FEATURES:`);
  console.log(`   ✅ Multi-session WhatsApp (whatsapp-web.js)`);
  console.log(`   ✅ Round-Robin messaging with anti-ban protection`);
  console.log(`   🤖 AI Chatbot Mode (Sarvam AI with SQL integration)`);
  console.log(`   📊 Real-time database access (MySQL)`);
  console.log(`   💬 Chat memory & conversation history`);
  console.log(`   📝 OT Message auto-reply`);
  console.log(`\n📝 API Endpoints:`);
  console.log(`   POST /start-session - Create new WhatsApp session`);
  console.log(`   POST /send-message - Send message(s)`);
  console.log(`   GET  /sessions - List all sessions with assignments`);
  console.log(`   POST /session/:id/assignments - Update feature assignments`);
  console.log(`   POST /ai/clear-history/:phone - Clear AI conversation`);
  console.log(`   GET  /ai/stats - Get AI conversation statistics`);
  console.log(`   GET  /db/test - Test database connection`);
  console.log(`   GET  /db/order/:orderNumber - Get order status`);
  console.log(`${'='.repeat(70)}\n`);

  // Restore previous sessions
  await restoreSessions();
});
