const fetch = require('node-fetch');
const DatabaseHelper = require('./wpp/config/databaseHelper');
const SQLAgent = require('./wpp/config/sqlAgent');
const MarketingPersonStore = require('./marketingPersonStore');

// AI Configuration for Sarvam AI
const AI_CONFIG = {
  API_KEY: 'sk_sggnlnzm_2TzPY0ameO13qAWYxikieql0',
  API_URL: 'https://api.sarvam.ai/v1/chat/completions',
  MODEL: 'sarvam-m',
  SYSTEM_PROMPT: `You are an AI assistant for Thirupathybright Industries with DIRECT DATABASE ACCESS.

IMPORTANT FORMATTING RULES:
- Do NOT use markdown (no **, *, #, -, backticks, or --- lines)
- Do NOT use emojis
- Use plain text only
- Use a blank line between sections
- For lists, write each item on its own line with a number or label

CAPABILITIES:
- Real-time access to company database
- Automatic SQL query generation for orders, customers, dispatches, invoices, weightments
- You will receive actual data from the database - present it clearly and concisely

WHEN PRESENTING ORDER INFORMATION, SHOW IN THIS EXACT ORDER:

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

(If dispatches exist, list each dispatch with weight and completion date on separate lines)

STATUS-BASED RULES:
- PENDING: Show "Production is yet to begin" if material_status is empty
- IN_PROGRESS: Show material status, expected date, dispatch progress, remaining quantity
- COMPLETED: Show dispatch details with dates (DO NOT show material status or expected date)

Keep responses simple and concise. Plain text only. No markdown. No emojis.`
};

// In-memory chat history store (key: userJid, value: messages array)
const chatHistory = new Map();

// Maximum messages to keep per user (prevents memory bloat)
const MAX_HISTORY_PER_USER = 10;

/**
 * Get AI response for a user message
 * @param {string} userMessage - The message from the user
 * @param {string} userJid - The user's JID (e.g., user@domain.com)
 * @returns {Promise<string>} - AI response
 */
async function getAIResponse(userMessage, userJid) {
  try {
    // Get or initialize chat history for this user
    if (!chatHistory.has(userJid)) {
      chatHistory.set(userJid, []);
    }

    const history = chatHistory.get(userJid);
    const isNewUser = history.length === 0;

    // Check if this is a new user greeting
    if (isNewUser && /^(hi|hello|hey|hii|helo|hiii|namaste|greetings?)$/i.test(userMessage.trim())) {
      console.log(`👋 New user detected: ${userJid}`);
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

      // Add to history
      history.push({
        role: 'user',
        content: userMessage
      });
      history.push({
        role: 'assistant',
        content: introduction
      });

      return introduction;
    }

    let contextMessage = '';

    // Get marketing persons assignment for this user (supports multiple)
    const marketingPersons = MarketingPersonStore.getMarketingPersons(userJid);

    if (marketingPersons.length > 0) {
      console.log(`🔒 User ${userJid} assigned to marketing person(s): ${marketingPersons.join(', ')}`);
    } else {
      console.log(`⚠️ User ${userJid} has no marketing person assigned - will see all data`);
    }

    // Use SQL Agent for ALL queries - let AI figure out what to query
    console.log(`🤖 Processing with SQL Agent: "${userMessage}"`);

    // Use SQL Agent to automatically generate and execute SQL query
    // Pass marketing persons array to filter results
    const sqlResult = await SQLAgent.queryFromNaturalLanguage(userMessage, AI_CONFIG, marketingPersons.length > 0 ? marketingPersons : null);

    if (sqlResult.success && sqlResult.count > 0) {
      // Data found - format it
      contextMessage = SQLAgent.formatResultForAI(sqlResult);
      console.log(`✅ SQL Agent found ${sqlResult.count} results`);

      // If the formatter built a ready-made plain-text reply, return it directly
      // without sending it through the AI (avoids markdown re-formatting)
      if (contextMessage.includes('[DIRECT_REPLY:')) {
        const match = contextMessage.match(/\[DIRECT_REPLY:\n([\s\S]*?)\]$/);
        if (match) {
          const directText = match[1].trim();
          console.log(`📤 Sending direct plain-text reply (${sqlResult.count} records)`);
          // Still add to history so context is preserved
          history.push({ role: 'user',      content: userMessage });
          history.push({ role: 'assistant', content: directText });
          if (history.length > MAX_HISTORY_PER_USER) {
            history.splice(0, history.length - MAX_HISTORY_PER_USER);
          }
          return directText;
        }
      }
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
    history.push({
      role: 'user',
      content: userMessageWithContext
    });

    // Keep only last MAX_HISTORY_PER_USER messages
    if (history.length > MAX_HISTORY_PER_USER) {
      history.splice(0, history.length - MAX_HISTORY_PER_USER);
    }

    // Prepare messages for API (keep last 6 messages for context)
    const recentHistory = history.slice(-6);
    const messagesForAPI = [];

    const isNewConversation = recentHistory.length <= 1;

    if (isNewConversation) {
      // First message - include system prompt
      messagesForAPI.push({
        role: 'user',
        content: `${AI_CONFIG.SYSTEM_PROMPT}\n\nUser: ${recentHistory[0].content}`
      });
    } else {
      // Ensure alternating pattern (user -> assistant -> user...)
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

      // Ensure first message is from user
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

    console.log(`🤖 Sending to Sarvam AI for ${userJid}:`, JSON.stringify(messagesForAPI).substring(0, 500));

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
      console.error('❌ Sarvam AI API Error:', errorText);
      throw new Error(`AI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Sarvam AI Response received');

    // Extract AI response
    const aiMessage = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    // Add AI response to history
    history.push({
      role: 'assistant',
      content: aiMessage
    });

    return aiMessage;

  } catch (error) {
    console.error('❌ AI Error:', error.message);
    return 'Sorry, I am experiencing technical difficulties. Please try again later.';
  }
}

/**
 * Clear conversation history for a user
 * @param {string} userJid - The user's JID
 */
function clearHistory(userJid) {
  if (chatHistory.has(userJid)) {
    chatHistory.delete(userJid);
    console.log(`🗑️ Cleared history for ${userJid}`);
  }
}

/**
 * Clean up old chat histories (call periodically to prevent memory leaks)
 */
function cleanupOldHistories() {
  const MAX_USERS = 100; // Keep history for max 100 users
  if (chatHistory.size > MAX_USERS) {
    // Remove oldest entries (simple FIFO)
    const keysToDelete = Array.from(chatHistory.keys()).slice(0, chatHistory.size - MAX_USERS);
    keysToDelete.forEach(key => chatHistory.delete(key));
    console.log(`🧹 Cleaned up ${keysToDelete.length} old chat histories`);
  }
}

// Periodic cleanup every 30 minutes
setInterval(cleanupOldHistories, 30 * 60 * 1000);

module.exports = {
  getAIResponse,
  clearHistory,
  cleanupOldHistories
};
