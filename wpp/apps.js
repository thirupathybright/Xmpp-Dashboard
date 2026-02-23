// apps.js - Baileys Multi-Session WhatsApp with Assignment-Based Routing
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys');

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Logger
const logger = pino({ level: 'silent' });

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Directories
const authDir = path.join(__dirname, 'baileys_auth');
const uploadsDir = path.join(__dirname, 'uploads');

[authDir, uploadsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Session storage: sessionId -> { sock, status, groups, dbData }
const sessions = new Map();

// Message queue processing state
let isProcessingQueue = false;

// Queue promise resolvers (messageId -> {resolve, reject})
const queueResolvers = new Map();

// Session usage tracking (anti-ban)
const sessionUsage = new Map();

// Anti-ban config - Human-like behavior to avoid detection
const ANTI_BAN = {
  // Random delay between messages (1-3 minutes to appear human)
  MIN_DELAY_MS: 60000,      // 1 minute minimum
  MAX_DELAY_MS: 180000,     // 3 minutes maximum

  // Random typing duration (appears like human typing speed)
  MIN_TYPING_MS: 2000,      // 2 seconds minimum
  MAX_TYPING_MS: 8000,      // 8 seconds maximum

  // Random thinking time before typing starts
  MIN_READING_MS: 1000,     // 1 second minimum
  MAX_READING_MS: 3000,     // 3 seconds maximum

  // Messages per interval
  MAX_PER_INTERVAL: 1,      // 1 message per interval
  INTERVAL_MS: 60000,       // Base interval is 1 minute (will be randomized)

  // Advanced anti-ban features
  MAX_MESSAGES_PER_HOUR: 50,           // Don't exceed 50 messages per hour per session
  BREAK_AFTER_MESSAGES: 10,            // Take a break after every 10 messages
  BREAK_DURATION_MIN_MS: 300000,       // 5 minutes minimum break
  BREAK_DURATION_MAX_MS: 900000,       // 15 minutes maximum break

  // Presence simulation
  RANDOM_PRESENCE_UPDATE: true,        // Randomly update presence to appear active
  PRESENCE_UPDATE_CHANCE: 0.3,         // 30% chance to update presence randomly

  // Read receipts
  SIMULATE_READ_RECEIPTS: true,        // Mark messages as read before replying
  READ_DELAY_MIN_MS: 500,              // Minimum delay before marking as read
  READ_DELAY_MAX_MS: 2000,             // Maximum delay before marking as read

  // Typing patterns
  TYPING_PAUSES: true,                 // Add random pauses while "typing"
  TYPING_PAUSE_CHANCE: 0.2,            // 20% chance of pause during typing
  TYPING_PAUSE_DURATION_MS: 1000       // 1 second pause duration
};

// Helper function to get random delay within a range
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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

// ========== HELPER FUNCTIONS ==========

function generateSessionId() {
  return `baileys_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function formatPhone(phone) {
  if (phone.includes('@c.us') || phone.includes('@g.us')) return phone;
  return phone.replace(/\D/g, '') + '@c.us';
}

function extractPhone(jid) {
  return jid.replace(/@c\.us|@s\.whatsapp\.net|@g\.us/g, '');
}

function getCurrentMinute() {
  const now = new Date();
  now.setSeconds(0, 0);
  return now.getTime();
}

function canSend(sessionId) {
  if (!sessionUsage.has(sessionId)) {
    sessionUsage.set(sessionId, {
      currentMinute: getCurrentMinute(),
      count: 0,
      nextAllowedTime: Date.now(), // First message can be sent immediately
      hourlyCount: 0,
      hourStartTime: Date.now(),
      consecutiveMessages: 0,
      onBreak: false,
      breakEndTime: null
    });
  }

  const usage = sessionUsage.get(sessionId);
  const now = Date.now();
  const currentMinute = getCurrentMinute();

  // Check if we're on a scheduled break
  if (usage.onBreak && usage.breakEndTime) {
    if (now < usage.breakEndTime) {
      const waitSeconds = Math.ceil((usage.breakEndTime - now) / 1000);
      const waitMinutes = Math.ceil(waitSeconds / 60);
      console.log(`☕ Session ${sessionId} on break for ${waitMinutes} more minutes`);
      return { allowed: false, waitSeconds, reason: 'break' };
    } else {
      // Break is over
      usage.onBreak = false;
      usage.breakEndTime = null;
      usage.consecutiveMessages = 0;
      console.log(`✅ Session ${sessionId} break ended, ready to send`);
    }
  }

  // Reset hourly count every hour
  if (now - usage.hourStartTime >= 3600000) { // 1 hour
    usage.hourlyCount = 0;
    usage.hourStartTime = now;
  }

  // Check hourly limit (anti-ban)
  if (usage.hourlyCount >= ANTI_BAN.MAX_MESSAGES_PER_HOUR) {
    const waitSeconds = Math.ceil((usage.hourStartTime + 3600000 - now) / 1000);
    const waitMinutes = Math.ceil(waitSeconds / 60);
    console.log(`⏳ Session ${sessionId} reached hourly limit (${ANTI_BAN.MAX_MESSAGES_PER_HOUR}/hour), wait ${waitMinutes} min`);
    return { allowed: false, waitSeconds, reason: 'hourly_limit' };
  }

  // Reset count every minute
  if (usage.currentMinute !== currentMinute) {
    usage.currentMinute = currentMinute;
    usage.count = 0;
  }

  // Check if we need to wait based on randomized delay
  if (now < usage.nextAllowedTime) {
    const waitMs = usage.nextAllowedTime - now;
    const waitSeconds = Math.ceil(waitMs / 1000);
    return { allowed: false, waitSeconds, reason: 'rate_limit' };
  }

  // Check if we've exceeded the rate limit for this minute
  if (usage.count >= ANTI_BAN.MAX_PER_INTERVAL) {
    const waitSeconds = Math.ceil((currentMinute + ANTI_BAN.INTERVAL_MS - now) / 1000);
    return { allowed: false, waitSeconds, reason: 'per_minute_limit' };
  }

  return { allowed: true };
}

function incrementUsage(sessionId) {
  const usage = sessionUsage.get(sessionId);
  if (usage) {
    usage.count++;
    usage.hourlyCount++;
    usage.consecutiveMessages++;

    // Check if we need a break (after 10 consecutive messages)
    if (usage.consecutiveMessages >= ANTI_BAN.BREAK_AFTER_MESSAGES) {
      const breakDuration = getRandomDelay(ANTI_BAN.BREAK_DURATION_MIN_MS, ANTI_BAN.BREAK_DURATION_MAX_MS);
      usage.onBreak = true;
      usage.breakEndTime = Date.now() + breakDuration;
      const breakMinutes = Math.ceil(breakDuration / 60000);
      console.log(`☕ ${sessionId}: Taking ${breakMinutes} min break after ${usage.consecutiveMessages} messages`);
      return;
    }

    // Set next allowed time with random delay (1-3 minutes) for human-like behavior
    const randomDelay = getRandomDelay(ANTI_BAN.MIN_DELAY_MS, ANTI_BAN.MAX_DELAY_MS);
    usage.nextAllowedTime = Date.now() + randomDelay;

    const delayMinutes = (randomDelay / 60000).toFixed(1);
    console.log(`📊 ${sessionId}: ${usage.count}/${ANTI_BAN.MAX_PER_INTERVAL} | ${usage.hourlyCount}/${ANTI_BAN.MAX_MESSAGES_PER_HOUR}/hr | Next in ${delayMinutes} min`);
  }
}

function broadcastSessions() {
  const list = Array.from(sessions.values()).map(s => ({
    sessionId: s.sessionId,
    status: s.status,
    groups: s.groups || [],
    assignments: s.dbData || {},
    usage: sessionUsage.get(s.sessionId)
  }));

  io.emit('sessions', list);
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

    // Keep only last 6 messages (3 user + 3 assistant) to maintain conversation context
    // With optimized SQL data formatting (3 records, essential fields only), this stays within token limit
    const recentHistory = updatedHistory.slice(-6);

    // Prepare messages for AI API
    // Sarvam AI requires strict alternating user/assistant messages
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
          // Skip consecutive messages of same role
          console.log(`⚠️ Skipping consecutive ${msg.role} message to maintain alternating pattern`);
        }
      }

      // Ensure first message is from user and last message is from user
      if (messagesForAPI.length === 0) {
        messagesForAPI.push(recentHistory[recentHistory.length - 1]);
      } else if (messagesForAPI[0].role !== 'user') {
        // Remove all messages until we find a user message
        while (messagesForAPI.length > 0 && messagesForAPI[0].role !== 'user') {
          messagesForAPI.shift();
        }
        // If no user message found, use the last message
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

// ========== CREATE BAILEYS SOCKET ==========

async function createSocket(sessionId) {
  const sessionFolder = path.join(authDir, sessionId);
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  console.log(`📱 Creating socket: ${sessionId}`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      browser: ['Chrome', '', ''],
      markOnlineOnConnect: true
    });

    // Load JSON data
    const dbData = SessionStore.getSession(sessionId);

    let sessionData = sessions.get(sessionId) || {
      sock: null,
      status: { status: 'CONNECTING', isLoggedIn: false, number: null },
      qrCode: null,
      sessionId,
      groups: [],
      dbData: dbData || {}
    };

    sessionData.sock = sock;
    sessionData.dbData = dbData || {};
    sessions.set(sessionId, sessionData);

    broadcastSessions();

    // Save to JSON
    SessionStore.saveSession(sessionId, null, 'connecting');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`📲 QR for ${sessionId}`);
        // Convert QR to base64 image
        const qrBase64 = await QRCode.toDataURL(qr);
        const qrBase64Only = qrBase64.split(',')[1]; // Remove data:image/png;base64, prefix

        sessionData.qrCode = qrBase64Only;
        sessionData.status = { status: 'QR_RECEIVED', isLoggedIn: false, number: null };
        io.emit('qr', { sessionId, qrCode: qrBase64Only });
        broadcastSessions();
      }

      if (connection === 'open') {
        const phoneNumber = sock.user.id.split(':')[0];
        sessionData.status = { status: 'CONNECTED', isLoggedIn: true, number: phoneNumber };
        sessionData.qrCode = null;

        console.log(`✅ ${sessionId} connected as ${phoneNumber}`);

        // Save to JSON
        SessionStore.saveSession(sessionId, phoneNumber, 'connected');
        sessionData.dbData = SessionStore.getSession(sessionId);

        // Load groups after 5 seconds
        setTimeout(() => loadGroups(sessionId), 5000);

        broadcastSessions();

        // Trigger queue
        if (!isProcessingQueue && QueueStore.getQueueLength() > 0) {
          setTimeout(processQueue, 1000);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log(`🔄 Reconnecting ${sessionId}...`);
          setTimeout(() => createSocket(sessionId), 3000);
        } else {
          console.log(`❌ ${sessionId} logged out`);
          sessions.delete(sessionId);
          sessionUsage.delete(sessionId);

          SessionStore.deleteSession(sessionId);

          if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
          }
        }

        broadcastSessions();
      }
    });

    // ========== MESSAGE HANDLER - AUTO-REPLIES & AI ==========
    // NOTE: This handler ONLY processes INCOMING messages for auto-replies.
    // Manual messages sent via /send-message API are NOT affected by this logic.
    // Any message can be sent via the API regardless of these auto-reply features.
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
          const senderJid = msg.key.remoteJid;
          const phone = extractPhone(senderJid);
          const dbData = sessionData.dbData;

          // Skip group messages for AI mode (only respond to direct messages)
          const isGroup = senderJid.endsWith('@g.us');

          // AI MODE - Auto-reply with AI chatbot (only for direct messages)
          // IMPORTANT: AI responses are sent IMMEDIATELY from the SAME session that received the message
          // - No queue: Messages bypass the queue system entirely
          // - No rate limits: AI can respond instantly without 1-minute delay
          // - Same session: Reply is sent from the same WhatsApp number that received it
          if (dbData && dbData.ai_mode_enabled && !isGroup && text.trim()) {
            console.log(`🤖 AI Mode: Message from ${phone} on ${sessionId}`);

            try {
              await sock.sendPresenceUpdate('composing', senderJid);

              // Get AI response
              const aiResponse = await getAIResponse(text, phone);

              // Simulate typing delay based on response length
              const typingDelay = Math.min(3000, aiResponse.length * 30); // 30ms per character, max 3s
              await delay(typingDelay);

              await sock.sendPresenceUpdate('paused', senderJid);
              // Send directly from this session (bypasses queue and rate limits)
              await sock.sendMessage(senderJid, { text: aiResponse });

              console.log(`✅ AI response sent to ${phone} from ${sessionId}`);
            } catch (err) {
              console.error(`❌ AI error:`, err.message);
            }

            // Skip other auto-replies if AI mode handled the message
            continue;
          }

          // OT AUTO-REPLY - Only if this session has ot_message_enabled
          if (text.trim().toUpperCase() === 'OT') {
            if (dbData && dbData.ot_message_enabled) {
              console.log(`📩 OT request on ${sessionId} (enabled)`);

              try {
                await sock.sendPresenceUpdate('composing', senderJid);
                await delay(1500);
                await sock.sendPresenceUpdate('paused', senderJid);

                const reply = `Hello! Your OT request has been received.\n\n` +
                  `This is an automated response from ${sessionData.status.number}.\n\n` +
                  `Your overtime details will be sent to you shortly.`;

                await sock.sendMessage(senderJid, { text: reply });

                console.log(`✅ OT response sent to ${phone}`);
              } catch (err) {
                console.error(`❌ OT error:`, err.message);
              }
            } else {
              console.log(`⚠️ OT request on ${sessionId} but NOT enabled`);
            }
          }

          // Group detection - add new groups
          if (isGroup) {
            const groupId = senderJid;
            if (!sessionData.groups.find(g => g.id === groupId)) {
              try {
                await delay(2000);
                const metadata = await sock.groupMetadata(groupId);
                sessionData.groups.push({
                  id: groupId,
                  name: metadata.subject || 'Unknown',
                  participants: metadata.participants?.length || 0
                });
                console.log(`✅ Added group: ${metadata.subject}`);
                broadcastSessions();
              } catch (err) {
                console.log(`⚠️ Could not fetch group metadata: ${err.message}`);
              }
            }
          }
        }
      }
    });

    return sock;

  } catch (error) {
    console.error(`❌ Error creating socket:`, error);
    const sessionData = sessions.get(sessionId);
    if (sessionData) {
      sessionData.status = { status: 'ERROR', isLoggedIn: false, number: null, error: error.message };
      SessionStore.updateStatus(sessionId, 'error');
      broadcastSessions();
    }
    throw error;
  }
}

// ========== LOAD GROUPS ==========

async function loadGroups(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData || !sessionData.sock) return;

  console.log(`📋 Loading groups for ${sessionId}...`);

  try {
    await delay(3000);
    const allChats = await sessionData.sock.groupFetchAllParticipating();

    if (allChats) {
      sessionData.groups = Object.values(allChats).map(g => ({
        id: g.id,
        name: g.subject || 'Unknown',
        participants: g.participants?.length || 0
      }));

      console.log(`✅ Loaded ${sessionData.groups.length} groups`);
      broadcastSessions();
    }
  } catch (err) {
    console.log(`⚠️ Error loading groups: ${err.message}`);
  }
}

// ========== LOAD EXISTING SESSIONS ==========

async function loadExistingSessions() {
  console.log('🔍 Loading existing sessions...');

  try {
    const jsonSessions = SessionStore.getAllSessions();
    console.log(`💾 Found ${jsonSessions.length} sessions in JSON`);

    if (fs.existsSync(authDir)) {
      const folders = fs.readdirSync(authDir)
        .filter(f => fs.statSync(path.join(authDir, f)).isDirectory() && f.startsWith('baileys_'));

      console.log(`📁 Found ${folders.length} session folders`);

      for (const sessionId of folders) {
        console.log(`🔄 Restoring ${sessionId}...`);

        sessions.set(sessionId, {
          sock: null,
          status: { status: 'RESTORING', isLoggedIn: false, number: null },
          qrCode: null,
          sessionId,
          groups: [],
          dbData: {}
        });

        await createSocket(sessionId);
        await delay(2000);
      }

      if (folders.length > 0) broadcastSessions();
    }
  } catch (error) {
    console.error('❌ Error loading sessions:', error);
  }
}

// ========== MESSAGE SENDING ==========

async function sendMessage(sock, phone, message) {
  const jid = formatPhone(phone);

  try {
    // Advanced anti-ban: Simulate reading the message first (mark as read)
    if (ANTI_BAN.SIMULATE_READ_RECEIPTS) {
      const readDelay = getRandomDelay(ANTI_BAN.READ_DELAY_MIN_MS, ANTI_BAN.READ_DELAY_MAX_MS);
      await delay(readDelay);
      // Note: WhatsApp doesn't allow marking messages as read for outgoing messages
      // This delay simulates natural behavior of reading before responding
    }

    // Human-like behavior: Random "thinking/reading" delay before typing (1-3 seconds)
    const readingDelay = getRandomDelay(ANTI_BAN.MIN_READING_MS, ANTI_BAN.MAX_READING_MS);
    await delay(readingDelay);

    // Random chance to update presence (appear active)
    if (ANTI_BAN.RANDOM_PRESENCE_UPDATE && Math.random() < ANTI_BAN.PRESENCE_UPDATE_CHANCE) {
      await sock.sendPresenceUpdate('available', jid);
      await delay(500);
    }

    // Show typing indicator
    await sock.sendPresenceUpdate('composing', jid);

    // Human-like behavior: Random typing duration (2-8 seconds)
    // Longer messages = longer typing time (more realistic)
    const baseTypingDelay = getRandomDelay(ANTI_BAN.MIN_TYPING_MS, ANTI_BAN.MAX_TYPING_MS);
    const messageLength = message.length;
    let typingDelay = Math.min(baseTypingDelay + (messageLength * 20), 15000); // Max 15 seconds

    // Advanced: Add random pauses while typing (simulates thinking/corrections)
    if (ANTI_BAN.TYPING_PAUSES && Math.random() < ANTI_BAN.TYPING_PAUSE_CHANCE) {
      const halfTyping = typingDelay / 2;
      await delay(halfTyping);

      // Pause typing
      await sock.sendPresenceUpdate('paused', jid);
      await delay(ANTI_BAN.TYPING_PAUSE_DURATION_MS);

      // Resume typing
      await sock.sendPresenceUpdate('composing', jid);
      await delay(halfTyping);
    } else {
      await delay(typingDelay);
    }

    // Stop typing indicator
    await sock.sendPresenceUpdate('paused', jid);

    // Small random delay before actually sending (100-500ms) - more human-like
    await delay(getRandomDelay(100, 500));

    // Send the message
    await sock.sendMessage(jid, { text: message });

    // Random chance to go "offline" briefly after sending (natural behavior)
    if (Math.random() < 0.1) { // 10% chance
      await delay(getRandomDelay(500, 1500));
      await sock.sendPresenceUpdate('unavailable', jid);
    }

    const totalTime = ((readingDelay + typingDelay) / 1000).toFixed(1);
    console.log(`✅ Sent to ${phone} (took ${totalTime}s - human-like with pauses)`);
    return true;
  } catch (error) {
    console.error(`❌ Send failed:`, error.message);
    return false;
  }
}

// ========== GET SESSION FOR FEATURE ==========
// Returns the best available session for a feature
// Tries all sessions assigned to the feature and picks the first one that is:
// 1. Online and connected
// 2. Not rate-limited

async function getSessionForFeature(feature, skipRateLimited = false) {
  try {
    // Get all sessions assigned to this feature
    const jsonSessions = SessionStore.getAllSessionsForFeature(feature);

    if (!jsonSessions || jsonSessions.length === 0) {
      console.log(`⚠️ No sessions assigned for feature: ${feature}`);
      return null;
    }

    console.log(`🔍 Found ${jsonSessions.length} session(s) for ${feature}, checking availability...`);

    // Try each session until we find one that's available
    for (const jsonSession of jsonSessions) {
      const session = sessions.get(jsonSession.session_id);

      // Check if session is connected
      if (!session || !session.sock || !session.status.isLoggedIn) {
        console.log(`⚠️ Session ${jsonSession.session_id} not connected, trying next...`);
        continue;
      }

      // If we need to skip rate-limited sessions, check rate limit
      if (skipRateLimited) {
        const check = canSend(session.sessionId);
        if (!check.allowed) {
          console.log(`⏰ Session ${jsonSession.session_id} rate limited, trying next...`);
          continue;
        }
      }

      // Found an available session!
      console.log(`✅ Using session for ${feature}: ${jsonSession.session_id} (${jsonSession.phone_number})`);
      return session;
    }

    // No available sessions found
    console.log(`⚠️ No available sessions for ${feature} (all offline or rate-limited)`);
    return null;

  } catch (error) {
    console.error(`❌ Error getting session for ${feature}:`, error);
    return null;
  }
}

// ========== QUEUE PROCESSOR ==========
// IMPORTANT: Queue processor now SKIPS messages whose sessions are unavailable or rate-limited
// instead of blocking the entire queue. This allows messages for available sessions to be
// processed while waiting for unavailable/rate-limited sessions.
//
// Multi-Session Support: Multiple sessions can be assigned to the same feature
// - If Session A for a feature is offline, it will try Session B, C, etc.
// - If Session A is rate-limited, it will try Session B, C, etc.
// - Only skips if ALL sessions for a feature are offline or rate-limited
//
// Rate Limiting: Random delays (1-3 minutes) PER SESSION for human-like behavior
// - Each session has independent rate limits
// - Random delays between messages to avoid automation detection
// - AI MODE EXCEPTION: AI messages have NO rate limits and can send instantly
// - Skipped messages remain in "pending" status and will be retried in the next round.
//
// Anti-Ban Features (Advanced):
// 1. Random Delays:
//    - Random typing duration (2-8 seconds) based on message length
//    - Random reading delay (1-3 seconds) before typing starts
//    - Random delay between messages (1-3 minutes)
//    - Random pauses while typing (20% chance, 1 second pause)
//
// 2. Rate Limiting:
//    - 1 message per 1-3 minutes (randomized)
//    - Maximum 50 messages per hour per session
//    - Automatic breaks after 10 consecutive messages (5-15 min break)
//
// 3. Human-like Behavior:
//    - Presence updates (available, composing, paused, unavailable)
//    - Random 30% chance to show "online" status
//    - Random 10% chance to go "offline" after sending
//    - Read receipt simulation with delays
//    - Typing pauses (simulates corrections/thinking)
//
// 4. Safety Limits:
//    - Hourly message cap prevents spam detection
//    - Scheduled breaks appear like natural user behavior
//    - Variable timing makes automation undetectable

async function processQueue() {
  if (isProcessingQueue) return;

  const queueLength = QueueStore.getQueueLength();
  if (queueLength === 0) return;

  isProcessingQueue = true;
  console.log(`📬 Processing queue: ${queueLength} messages`);

  let skippedMessages = new Set(); // Track messages we've skipped this round
  let processedAnyMessage = false; // Track if we processed at least one message

  while (true) {
    const job = QueueStore.getFirstPending();

    if (!job) {
      // No more pending messages
      break;
    }

    // If we've already skipped this message in this round, stop to avoid infinite loop
    if (skippedMessages.has(job.id)) {
      console.log(`⚠️ All pending messages have been skipped (no sessions available), will retry later...`);
      break;
    }

    // Mark as processing
    QueueStore.updateMessageStatus(job.id, 'processing');

    // Get session based on feature assignment
    // skipRateLimited = true means it will automatically try other sessions if one is rate-limited
    // AI mode doesn't skip rate-limited sessions since AI has no rate limits
    let session = null;

    if (job.feature) {
      const skipRateLimited = (job.feature !== 'ai_mode');
      session = await getSessionForFeature(job.feature, skipRateLimited);
    } else {
      // Use any connected session (round-robin)
      const connected = Array.from(sessions.values()).filter(s => s.sock && s.status.isLoggedIn);
      if (connected.length > 0) {
        session = connected[0];
      }
    }

    if (!session) {
      console.log(`⚠️ No session available for ${job.feature || 'general'}, skipping to next message...`);
      // Mark back to pending so it can be retried later
      QueueStore.updateMessageStatus(job.id, 'pending');
      // Track that we skipped this message
      skippedMessages.add(job.id);
      // Continue to next message instead of blocking the queue
      continue;
    }

    // Double-check rate limit (skip for AI mode - AI has no rate limits)
    if (job.feature !== 'ai_mode') {
      const check = canSend(session.sessionId);
      if (!check.allowed) {
        console.log(`⏰ Session ${session.sessionId} rate limited (wait ${check.waitSeconds}s), skipping to next message...`);
        // Mark back to pending so it can be retried later
        QueueStore.updateMessageStatus(job.id, 'pending');
        // Track that we skipped this message due to rate limit
        skippedMessages.add(job.id);
        // Continue to next message instead of blocking the queue
        continue;
      }
    } else {
      console.log(`🤖 AI Mode message - skipping rate limit check`);
    }

    try {
      console.log(`📤 Sending via ${session.sessionId} (${session.status.number})`);

      const success = await sendMessage(session.sock, job.phone, job.message);

      if (success) {
        // Mark as completed and delete from queue
        const result = {
          status: 'success',
          sentFrom: session.status.number,
          sessionId: session.sessionId,
          sentAt: new Date().toISOString()
        };

        QueueStore.updateMessageStatus(job.id, 'completed', result);

        // Don't increment usage for AI mode (AI has no rate limits)
        if (job.feature !== 'ai_mode') {
          incrementUsage(session.sessionId);
        }

        processedAnyMessage = true; // Mark that we successfully processed a message

        // Resolve promise if exists
        const resolver = queueResolvers.get(job.id);
        if (resolver) {
          resolver.resolve(result);
          queueResolvers.delete(job.id);
        }

        // Delete the message from queue after successful send
        QueueStore.deleteMessage(job.id);

        // Random delay before next message (human-like behavior)
        // Note: The main delay is handled by incrementUsage setting nextAllowedTime
        // This is just a small buffer between queue checks
        const remaining = QueueStore.getQueueLength();
        if (remaining > 0) {
          const smallDelay = getRandomDelay(1000, 3000); // 1-3 seconds between queue checks
          await delay(smallDelay);
        }
      } else {
        console.log(`⚠️ Send failed, marking as failed...`);
        QueueStore.updateMessageStatus(job.id, 'failed', { error: 'Send failed' });

        // Reject promise if exists
        const resolver = queueResolvers.get(job.id);
        if (resolver) {
          resolver.reject(new Error('Send failed'));
          queueResolvers.delete(job.id);
        }

        // Delete the failed message from queue
        QueueStore.deleteMessage(job.id);

        isProcessingQueue = false;
        setTimeout(processQueue, 3000);
        return;
      }

    } catch (error) {
      console.error('❌ Queue error:', error);
      QueueStore.updateMessageStatus(job.id, 'failed', { error: error.message });

      // Reject promise if exists
      const resolver = queueResolvers.get(job.id);
      if (resolver) {
        resolver.reject(error);
        queueResolvers.delete(job.id);
      }

      // Delete the failed message from queue
      QueueStore.deleteMessage(job.id);

      isProcessingQueue = false;
      setTimeout(processQueue, 3000);
      return;
    }
  }

  isProcessingQueue = false;

  // Check if there are still pending messages (that were skipped)
  const remainingPending = QueueStore.getQueueLength();
  if (remainingPending > 0) {
    if (processedAnyMessage) {
      console.log(`✅ Processed some messages, ${remainingPending} still pending. Continuing...`);
      // Schedule immediate retry since we made progress
      setTimeout(processQueue, 1000);
    } else {
      console.log(`⚠️ No messages processed this round, ${remainingPending} pending. Will retry in 5s...`);
      // Schedule delayed retry since no progress was made
      setTimeout(processQueue, 5000);
    }
  } else {
    console.log('✅ Queue complete');
  }
}

function queueMessage(phone, message, feature = null) {
  return new Promise((resolve, reject) => {
    // Add to JSON-based queue
    const queueItem = QueueStore.addMessage(phone, message, feature);
    console.log(`📥 Queued for ${phone} (feature: ${feature || 'general'}) - ID: ${queueItem.id}`);

    // Store promise resolvers
    queueResolvers.set(queueItem.id, { resolve, reject });

    // Trigger queue processing
    if (!isProcessingQueue) {
      setTimeout(processQueue, 500);
    }
  });
}

// ========== API ENDPOINTS ==========

app.post('/start-session', async (req, res) => {
  try {
    const sessionId = generateSessionId();
    console.log(`🚀 Starting session: ${sessionId}`);

    SessionStore.saveSession(sessionId, null, 'connecting');
    await createSocket(sessionId);

    res.json({ status: 'initialized', sessionId });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/logout-session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }

    if (session.sock) {
      await session.sock.logout();
    }

    const sessionFolder = path.join(authDir, sessionId);
    if (fs.existsSync(sessionFolder)) {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    }

    SessionStore.deleteSession(sessionId);

    sessions.delete(sessionId);
    sessionUsage.delete(sessionId);
    broadcastSessions();

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ message: error.message });
  }
});

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

      return {
        sessionId: db.session_id,
        phoneNumber: db.phone_number,
        status: runtime ? runtime.status : { status: db.status, isLoggedIn: false },
        groups: runtime ? runtime.groups : [],
        groupCount: runtime ? (runtime.groups || []).length : 0,
        assignments: {
          ot_message_enabled: Boolean(db.ot_message_enabled),
          checkin_checkout_enabled: Boolean(db.checkin_checkout_enabled),
          group_message_enabled: Boolean(db.group_message_enabled),
          pc_automation_enabled: Boolean(db.pc_automation_enabled),
          delegation_enabled: Boolean(db.delegation_enabled),
          helpticket_enabled: Boolean(db.helpticket_enabled),
          ai_mode_enabled: Boolean(db.ai_mode_enabled)
        },
        usageStats: usageStats
      };
    });

    res.json({ sessions: list });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Update session assignments
app.post('/session/:sessionId/assignments', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const assignments = req.body;

    SessionStore.updateAssignments(sessionId, assignments);

    // Reload JSON data in runtime
    const session = sessions.get(sessionId);
    if (session) {
      session.dbData = SessionStore.getSession(sessionId);
    }

    broadcastSessions();

    res.json({ status: 'success', message: 'Assignments updated' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Send message
// IMPORTANT: This endpoint ONLY accepts messages with a valid 'feature' parameter.
// Messages must be sent through one of these features:
// - 'ot_message' - OT Message Auto-Reply
// - 'checkin_checkout' - Check-in/Checkout Messages
// - 'group_message' - Group Messages
// - 'pc_automation' - PC Automation
// - 'delegation' - Delegation Messages
// - 'helpticket' - Help Ticket Messages
// - 'ai_mode' - AI Chatbot Mode
// General messages without a feature are NOT allowed.
app.post('/send-message', async (req, res) => {
  let { phone, message, phones, feature } = req.body;

  if (!phones && phone) phones = [phone];

  if (!phones || !Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Phone number(s) required' });
  }

  if (!message) {
    return res.status(400).json({ status: 'error', message: 'Message required' });
  }

  // VALIDATE FEATURE - Only allow specific features
  const allowedFeatures = [
    'ot_message',
    'checkin_checkout',
    'group_message',
    'pc_automation',
    'delegation',
    'helpticket',
    'ai_mode'
  ];

  if (!feature || !allowedFeatures.includes(feature)) {
    return res.status(400).json({
      status: 'error',
      message: `Feature is required and must be one of: ${allowedFeatures.join(', ')}`,
      providedFeature: feature || 'null',
      allowedFeatures: allowedFeatures
    });
  }

  try {
    const results = [];

    for (const phoneNumber of phones) {
      try {
        const result = await queueMessage(phoneNumber, message, feature);
        results.push({ phone: phoneNumber, ...result });
      } catch (error) {
        results.push({ phone: phoneNumber, status: 'error', message: error.message });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;

    return res.json({
      status: 'completed',
      total: results.length,
      success: successCount,
      failed: results.length - successCount,
      results
    });
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get all groups
app.get('/all-groups', (req, res) => {
  const allGroups = [];

  sessions.forEach((session) => {
    if (session.status.isLoggedIn && session.groups) {
      session.groups.forEach(group => {
        allGroups.push({
          ...group,
          sessionId: session.sessionId,
          sessionNumber: session.status.number
        });
      });
    }
  });

  res.json({ status: 'success', groups: allGroups, totalGroups: allGroups.length });
});

// Connection status
app.get('/connection-status', (req, res) => {
  const connectedCount = Array.from(sessions.values())
    .filter(s => s.sock && s.status.isLoggedIn).length;

  res.json({
    status: connectedCount > 0 ? 'connected' : 'disconnected',
    totalSessions: sessions.size,
    connectedSessions: connectedCount,
    queueLength: QueueStore.getQueueLength()
  });
});

// Queue status
app.get('/queue-status', (req, res) => {
  const available = Array.from(sessions.values())
    .filter(s => s.sock && s.status.isLoggedIn)
    .map(s => ({
      sessionId: s.sessionId,
      number: s.status.number
    }));

  const stats = QueueStore.getStats();
  const pendingMessages = QueueStore.getPendingMessages();

  res.json({
    queueLength: QueueStore.getQueueLength(),
    isProcessing: isProcessingQueue,
    availableSessions: available,
    currentRoundRobinIndex: stats.currentRoundRobinIndex || 0,
    stats: stats,
    queueMessages: pendingMessages.map(msg => ({
      phone: msg.phone,
      feature: msg.feature,
      status: msg.status,
      queuedAt: msg.queuedAt,
      message: msg.message
    }))
  });
});

// Get queue details
app.get('/queue-details', (req, res) => {
  try {
    const stats = QueueStore.getStats();
    const pending = QueueStore.getPendingMessages();

    res.json({
      status: 'success',
      stats: stats,
      pendingMessages: pending
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Clear completed/failed messages
app.post('/queue-cleanup', (req, res) => {
  try {
    const deleted = QueueStore.cleanup();
    res.json({
      status: 'success',
      message: `Cleaned up ${deleted} old messages`
    });
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

// Socket.io
io.on('connection', (socket) => {
  console.log('🔌 Socket connected');
  broadcastSessions();

  socket.on('disconnect', () => {
    console.log('🔌 Socket disconnected');
  });
});

// Cleanup
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

async function cleanup() {
  console.log('🧹 Cleaning up...');

  // Close all WhatsApp sessions
  for (const [, session] of sessions.entries()) {
    if (session.sock) {
      try {
        await session.sock.end();
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

// Periodic queue cleanup (every 1 hour)
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

// Start server
server.listen(port, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🚀 Baileys WhatsApp Multi-Session with Assignment Routing`);
  console.log(`${'='.repeat(70)}`);
  console.log(`🌐 Server: http://localhost:${port}`);
  console.log(`📁 Auth: ${authDir}`);
  console.log(`💾 Storage: sessions.json, message_queue.json & chat_memory.json`);
  console.log(`\n🎯 ASSIGNMENT FEATURES:`);
  console.log(`   ✅ OT Message - Auto-reply to "OT" requests`);
  console.log(`   ✅ Check-in/Checkout - Dedicated session for attendance`);
  console.log(`   ✅ Group Messages - Dedicated session for group broadcasts`);
  console.log(`   ✅ PC Automation - Dedicated session for automation tasks`);
  console.log(`   ✅ Delegation - Dedicated session for delegation messages (1/min)`);
  console.log(`   ✅ Help Ticket - Dedicated session for help ticket messages (1/min)`);
  console.log(`   🤖 AI Mode - Auto-reply with AI chatbot (Sarvam AI)`);
  console.log(`\n🔒 SECURITY: Messages can ONLY be sent through assigned features!`);
  console.log(`📝 General messages without a valid feature are BLOCKED!`);
  console.log(`${'='.repeat(70)}\n`);

  setTimeout(() => {
    loadExistingSessions();

    // Resume queue processing if there are pending messages
    const pendingCount = QueueStore.getQueueLength();
    if (pendingCount > 0) {
      console.log(`📬 Found ${pendingCount} pending messages in queue, resuming processing...`);
      setTimeout(processQueue, 3000);
    }
  }, 1000);
});
