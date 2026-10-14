require("dotenv").config();
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { client, xml } = require("@xmpp/client");
const { getAIResponse } = require("./aiHelper");
const DatabaseHelper = require("./wpp/config/databaseHelper");
const MarketingPersonStore = require("./marketingPersonStore");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const { ensureAdminAccount, verifyLogin, requireLogin } = require("./auth");
const ProsodyStats = require("./prosodyStats");
const createWebChat = require("./webchat");

ensureAdminAccount();

const app = express();
app.set("trust proxy", 1); // behind nginx: real client IP for login rate limiting
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Add JSON body parser for API endpoints
app.set("view engine", "ejs");

app.use(session({
  secret: process.env.DASHBOARD_SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
  },
}));

// ---- auth routes (must be registered before requireLogin) ----
app.get("/login", (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect(req.session.role === "user" ? "/chat" : "/");
  }
  res.render("login", { err: null, tab: req.query.tab === "user" ? "user" : "admin" });
});

app.post("/login", async (req, res) => {
  const { role, email, username, password } = req.body;

  // Sign in as User: verified against Prosody with the XMPP account itself.
  if (role === "user") {
    try {
      const xmppUser = await webchat.login(username, password, req.ip);
      return req.session.regenerate((err) => {
        if (err) return res.status(500).render("login", { err: "Login failed.", tab: "user" });
        req.session.authenticated = true;
        req.session.role = "user";
        req.session.xmppUser = xmppUser;
        res.redirect("/chat");
      });
    } catch (e) {
      return res.status(e.status || 500).render("login", { err: e.message, tab: "user" });
    }
  }

  // Sign in as Admin: existing dashboard account.
  if (verifyLogin(email, password)) {
    return req.session.regenerate((err) => {
      if (err) return res.status(500).render("login", { err: "Login failed.", tab: "admin" });
      req.session.authenticated = true;
      req.session.role = "admin";
      req.session.email = email;
      res.redirect("/");
    });
  }
  res.status(401).render("login", { err: "Invalid email or password.", tab: "admin" });
});

app.post("/logout", (req, res) => {
  const xmppUser = req.session && req.session.role === "user" ? req.session.xmppUser : null;
  if (xmppUser) webchat.logout(xmppUser);
  req.session.destroy(() => res.redirect("/login"));
});

app.use(requireLogin);

// ---- web chat for regular XMPP users (WhatsApp-Web style) ----
// webchat is created lazily below once helpers exist; routes are mounted here
// so the auth middleware order stays: login routes -> requireLogin -> app routes.
app.use("/api/chat", (req, res, next) => webchat.router(req, res, next));
app.get("/chat", (req, res) => {
  if (!req.session || req.session.role !== "user") return res.redirect("/");
  res.sendFile(`${__dirname}/public/chat.html`);
});

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// ===== CONFIG =====
const DOMAIN = "chat.thirupathybright.in";

// Prosody stores users here in your server:
const ACCOUNTS_DIR =
  "/var/lib/prosody/chat%2ethirupathybright%2ein/accounts";

// Bot credentials
const BOT_USERNAME = "broadcast";
const BOT_PASSWORD = "tbi@123";

// Message sender bot credentials (for API messages)
const MSG_BOT_USERNAME = "bot";
const MSG_BOT_PASSWORD = "bot123";

const XMPP_SERVICE = `xmpp://${DOMAIN}:5222`;

// AI Bot instance (persistent connection)
let aiBot = null;
// Message Bot instance (for sending notifications)
let messageBot = null;
// ==================

// ---- helpers ----
function safeUsername(u) {
  // allow only digits/letters/._-  (avoid command injection + invalid names)
  return (u || "").trim().match(/^[a-zA-Z0-9._-]+$/) ? u.trim() : null;
}

function listUsers() {
  const files = fs.readdirSync(ACCOUNTS_DIR);
  return files
    .filter((f) => f.endsWith(".dat"))
    .map((f) => f.replace(/\.dat$/, ""))
    .sort();
}

function buildExecError(err) {
  let msg = err?.message || String(err);
  if (err?.stderr) msg += `\n${err.stderr.toString().trim()}`;
  if (err?.stdout) msg += `\n${err.stdout.toString().trim()}`;
  return msg;
}

function runProsodyctlWithPassword(command, jid, newPassword) {
  const input = `${newPassword}\n${newPassword}\n`;
  try {
    return execFileSync("sudo", ["-n", "prosodyctl", command, jid], {
      input,
      encoding: "utf8",
    });
  } catch (sudoErr) {
    const sudoMessage = buildExecError(sudoErr);
    console.warn(`⚠️ sudo prosodyctl failed, trying direct prosodyctl: ${sudoMessage}`);
    try {
      return execFileSync("prosodyctl", [command, jid], {
        input,
        encoding: "utf8",
      });
    } catch (plainErr) {
      const plainMessage = buildExecError(plainErr);
      throw new Error(`Failed to run prosodyctl with sudo: ${sudoMessage}\nFailed to run prosodyctl without sudo: ${plainMessage}`);
    }
  }
}

function runProsodyctl(command, jid) {
  try {
    return execFileSync("sudo", ["-n", "prosodyctl", command, jid], {
      encoding: "utf8",
    });
  } catch (sudoErr) {
    const sudoMessage = buildExecError(sudoErr);
    console.warn(`⚠️ sudo prosodyctl failed, trying direct prosodyctl: ${sudoMessage}`);
    try {
      return execFileSync("prosodyctl", [command, jid], {
        encoding: "utf8",
      });
    } catch (plainErr) {
      const plainMessage = buildExecError(plainErr);
      throw new Error(`Failed to run prosodyctl with sudo: ${sudoMessage}\nFailed to run prosodyctl without sudo: ${plainMessage}`);
    }
  }
}

async function sendBroadcast(messageText) {
  const users = listUsers()
    .map((u) => `${u}@${DOMAIN}`)
    // optional: do not send to bot itself
    .filter((jid) => !jid.startsWith(`${BOT_USERNAME}@`))
    .filter((jid) => !jid.startsWith(`${MSG_BOT_USERNAME}@`));

  const xmpp = client({
    service: XMPP_SERVICE,
    domain: DOMAIN,
    username: BOT_USERNAME, // IMPORTANT: username only
    password: BOT_PASSWORD,
  });

  xmpp.on("error", (err) => console.error("XMPP error:", err));
  xmpp.on("status", (s) => console.log("XMPP status:", s));

  await xmpp.start();
  await xmpp.send(xml("presence"));

  let sent = 0;
  let failed = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const jid of users) {
    try {
      await xmpp.send(
        xml("message", { type: "chat", to: jid }, xml("body", {}, messageText))
      );
      sent++;
      await delay(150); // anti-flood
    } catch (e) {
      failed++;
      console.error("Failed to send to", jid, e?.message || e);
    }
  }

  await xmpp.stop();
  return { sent, failed, total: users.length };
}

// Send message to specific user via messageBot connection
async function sendMessageToUser(toJid, messageText) {
  try {
    if (!messageBot) {
      throw new Error("Message Bot is not running. Please start the bot first.");
    }

    console.log(`📤 [MESSAGE BOT] Sending message to ${toJid} from bot@${DOMAIN}`);
    console.log(`📤 [MESSAGE BOT] Message Bot connected: ${messageBot ? 'YES' : 'NO'}`);
    console.log(`📤 [MESSAGE BOT] Using account: ${MSG_BOT_USERNAME}@${DOMAIN}`);

    await messageBot.send(
      xml("message", { type: "chat", to: toJid }, xml("body", {}, messageText))
    );

    console.log(`✅ [MESSAGE BOT] Message sent successfully to ${toJid} from bot@${DOMAIN}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ [MESSAGE BOT] Failed to send message to ${toJid}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Send normal text message to a MUC group
async function sendGroupMessage(roomJid, messageText) {
  try {
    if (!messageBot) {
      throw new Error("Message Bot is not running. Please start the bot first.");
    }

    console.log(`📤 [MESSAGE BOT] Sending group message to ${roomJid}`);

    await joinMucRoom(roomJid);

    await messageBot.send(
      xml("message", { type: "groupchat", to: roomJid }, xml("body", {}, messageText))
    );

    await leaveMucRoom(roomJid);

    console.log(`✅ [MESSAGE BOT] Group message sent successfully to ${roomJid}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ [MESSAGE BOT] Failed to send group message to ${roomJid}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Join a MUC room and wait for join confirmation
async function joinMucRoom(roomJid) {
  const nickname = MSG_BOT_USERNAME;
  const roomWithNick = `${roomJid}/${nickname}`;

  console.log(`🚪 [MUC] Joining room ${roomJid} as ${nickname}`);

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      messageBot.removeListener("stanza", onPresence);
      // Some servers don't send confirmation; proceed anyway
      console.warn(`⚠️ [MUC] Join confirmation timeout for ${roomJid}, proceeding anyway`);
      resolve();
    }, 4000);

    function onPresence(stanza) {
      if (
        stanza.is("presence") &&
        stanza.attrs.from &&
        stanza.attrs.from.startsWith(roomJid + "/")
      ) {
        clearTimeout(timeout);
        messageBot.removeListener("stanza", onPresence);
        console.log(`✅ [MUC] Joined room ${roomJid}`);
        resolve();
      }
    }

    messageBot.on("stanza", onPresence);
    messageBot.send(
      xml("presence", { to: roomWithNick },
        xml("x", { xmlns: "http://jabber.org/protocol/muc" })
      )
    );
  });
}

// Leave a MUC room
async function leaveMucRoom(roomJid) {
  const roomWithNick = `${roomJid}/${MSG_BOT_USERNAME}`;
  await messageBot.send(xml("presence", { to: roomWithNick, type: "unavailable" }));
  console.log(`🚪 [MUC] Left room ${roomJid}`);
}

// Send image with caption to specific user or group
async function sendImageWithCaption(toJid, imageUrl, imageSize, caption = "", messageType = "chat") {
  try {
    if (!messageBot) {
      throw new Error("Message Bot is not running. Please start the bot first.");
    }

    const type = messageType === "groupchat" ? "groupchat" : "chat";
    console.log(`📤 [MESSAGE BOT] Sending image with caption to ${toJid} (type: ${type})`);
    console.log(`📤 [MESSAGE BOT] Image URL: ${imageUrl}`);
    console.log(`📤 [MESSAGE BOT] Caption: ${caption}`);

    // Build message body with format: URL|size|CAPTION:text
    // The size is required for the Android app to use fileParams.url instead of body
    let messageBody;

    if (caption && caption.trim()) {
      // With caption: body = URL|size|CAPTION:text
      messageBody = imageUrl + "|" + imageSize + "|CAPTION:" + caption.trim();
      console.log(`📤 [MESSAGE BOT] Sending with caption: ${caption.trim()}`);
    } else {
      // Without caption: body = URL|size OR just URL if no size
      messageBody = imageSize ? imageUrl + "|" + imageSize : imageUrl;
    }

    console.log(`📤 [MESSAGE BOT] Message body: ${messageBody}`);
    console.log(`📤 [MESSAGE BOT] OOB URL: ${imageUrl}`);

    // For group messages, join the room first
    if (type === "groupchat") {
      await joinMucRoom(toJid);
    }

    // Send single message with body and OOB
    // OOB always contains just the download URL
    const message = xml(
      "message",
      { type, to: toJid },
      xml("body", {}, messageBody),
      xml("x", { xmlns: "jabber:x:oob" }, xml("url", {}, imageUrl))
    );

    await messageBot.send(message);

    // Leave the room after sending — wait briefly for server to process/deliver
    if (type === "groupchat") {
      await new Promise(r => setTimeout(r, 1500));
      await leaveMucRoom(toJid);
    }

    console.log(`✅ [MESSAGE BOT] Image with caption sent successfully to ${toJid}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ [MESSAGE BOT] Failed to send image to ${toJid}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Discover HTTP upload service
async function discoverUploadService() {
  try {
    const requestId = `disco_${Date.now()}`;

    console.log(`🔍 [DISCOVERY] Discovering upload service on ${DOMAIN}`);

    const discoRequest = xml(
      "iq",
      { type: "get", to: DOMAIN, id: requestId },
      xml("query", { xmlns: "http://jabber.org/protocol/disco#items" })
    );

    const discoPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        messageBot.removeListener("stanza", onDiscoResponse);
        reject(new Error("Timeout discovering upload service"));
      }, 5000);

      function onDiscoResponse(stanza) {
        if (stanza.is("iq") && stanza.attrs.id === requestId && stanza.attrs.type === "result") {
          const query = stanza.getChild("query");
          if (query) {
            const items = query.getChildren("item");
            console.log(`🔍 [DISCOVERY] Found ${items.length} services`);

            for (const item of items) {
              console.log(`🔍 [DISCOVERY] Service: ${item.attrs.jid} - ${item.attrs.name || 'N/A'}`);
              // Look for upload service
              if (item.attrs.jid && (
                item.attrs.jid.startsWith("upload.") ||
                item.attrs.jid.includes("upload") ||
                (item.attrs.name && item.attrs.name.toLowerCase().includes("upload"))
              )) {
                clearTimeout(timeout);
                messageBot.removeListener("stanza", onDiscoResponse);
                console.log(`✅ [DISCOVERY] Found upload service: ${item.attrs.jid}`);
                resolve(item.attrs.jid);
                return;
              }
            }
          }

          clearTimeout(timeout);
          messageBot.removeListener("stanza", onDiscoResponse);
          reject(new Error("No upload service found"));
        }
      }

      messageBot.on("stanza", onDiscoResponse);
    });

    await messageBot.send(discoRequest);
    return await discoPromise;
  } catch (error) {
    console.error(`❌ [DISCOVERY] Failed:`, error.message);
    // Try multiple common upload service addresses
    const possibleAddresses = [
      `upload.${DOMAIN}`,
      `http.upload.${DOMAIN}`,
      `http_upload.${DOMAIN}`,
      DOMAIN  // Some setups use the main domain
    ];
    console.log(`🔍 [DISCOVERY] Will try fallback addresses:`, possibleAddresses);
    return possibleAddresses[0]; // Return the first one to try
  }
}

// Upload file to XMPP HTTP upload service
async function uploadFileToXMPP(fileBuffer, filename, mimeType) {
  try {
    console.log(`📤 [FILE UPLOAD] Requesting upload slot for ${filename}`);
    console.log(`📤 [FILE UPLOAD] File size: ${fileBuffer.length} bytes, MIME: ${mimeType}`);

    // Use the main domain for upload requests (not a subdomain)
    const uploadService = DOMAIN;
    console.log(`📤 [FILE UPLOAD] Using upload service: ${uploadService}`);

    const requestId = `upload_${Date.now()}`;

    // Request upload slot from HTTP upload component
    const slotRequest = xml(
      "iq",
      { type: "get", to: uploadService, id: requestId },
      xml(
        "request",
        {
          xmlns: "urn:xmpp:http:upload:0",
          filename: filename,
          size: fileBuffer.length.toString(),
          "content-type": mimeType
        }
      )
    );

    console.log(`📤 [FILE UPLOAD] Sending slot request to ${uploadService}`);
    console.log(`📤 [FILE UPLOAD] Request ID: ${requestId}`);

    // Send request and wait for response
    const slotPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        messageBot.removeListener("stanza", onSlotResponse);
        reject(new Error("Timeout waiting for upload slot (10s)"));
      }, 10000);

      function onSlotResponse(stanza) {
        console.log(`📥 [FILE UPLOAD] Received stanza:`, stanza.toString());

        // Check if this is our response
        if (stanza.is("iq") && stanza.attrs.id === requestId) {
          if (stanza.attrs.type === "result") {
            const slot = stanza.getChild("slot", "urn:xmpp:http:upload:0");
            if (slot) {
              const put = slot.getChild("put");
              const get = slot.getChild("get");

              if (put && get) {
                const uploadUrl = put.attrs.url;
                const getUrl = get.attrs.url;

                console.log(`✅ [FILE UPLOAD] Got slot URLs`);
                console.log(`📤 [FILE UPLOAD] PUT URL: ${uploadUrl}`);
                console.log(`📥 [FILE UPLOAD] GET URL: ${getUrl}`);

                clearTimeout(timeout);
                messageBot.removeListener("stanza", onSlotResponse);
                resolve({ uploadUrl, getUrl });
              } else {
                clearTimeout(timeout);
                messageBot.removeListener("stanza", onSlotResponse);
                reject(new Error("Invalid slot response - missing put/get URLs"));
              }
            } else {
              clearTimeout(timeout);
              messageBot.removeListener("stanza", onSlotResponse);
              reject(new Error("Invalid slot response - missing slot element"));
            }
          } else if (stanza.attrs.type === "error") {
            const error = stanza.getChild("error");
            const errorText = error ? error.toString() : "Unknown error";
            console.error(`❌ [FILE UPLOAD] Error response:`, errorText);

            clearTimeout(timeout);
            messageBot.removeListener("stanza", onSlotResponse);
            reject(new Error(`Upload slot request failed: ${errorText}`));
          }
        }
      }

      messageBot.on("stanza", onSlotResponse);
    });

    await messageBot.send(slotRequest);
    const { uploadUrl: putUrl, getUrl: downloadUrl } = await slotPromise;

    console.log(`📤 [FILE UPLOAD] Uploading file to PUT URL...`);

    // Upload file to the PUT URL
    const uploadResponse = await axios.put(putUrl, fileBuffer, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": fileBuffer.length
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    console.log(`📤 [FILE UPLOAD] Upload response status: ${uploadResponse.status}`);

    if (uploadResponse.status >= 200 && uploadResponse.status < 300) {
      console.log(`✅ [FILE UPLOAD] File uploaded successfully: ${downloadUrl}`);
      return { success: true, url: downloadUrl, size: fileBuffer.length };
    } else {
      throw new Error(`Upload failed with status ${uploadResponse.status}`);
    }
  } catch (error) {
    console.error(`❌ [FILE UPLOAD] Failed to upload file:`, error.message);
    console.error(`❌ [FILE UPLOAD] Stack:`, error.stack);
    return { success: false, error: error.message };
  }
}

// Initialize Message bot for sending notifications
async function startMessageBot() {
  if (messageBot) {
    console.log("⚠️ Message Bot already running");
    return;
  }

  ensureMessageBotAccount();

  console.log("📨 Starting Message Bot...");
  console.log(`📨 Account: ${MSG_BOT_USERNAME}@${DOMAIN}`);
  console.log(`📨 Password: ${MSG_BOT_PASSWORD.replace(/./g, '*')}`);

  messageBot = client({
    service: XMPP_SERVICE,
    domain: DOMAIN,
    username: MSG_BOT_USERNAME,
    password: MSG_BOT_PASSWORD,
  });

  messageBot.on("error", (err) => {
    console.error("❌ Message Bot error:", err);
  });

  messageBot.on("status", (status) => {
    console.log(`📨 Message Bot status: ${status}`);
  });

  messageBot.on("online", async () => {
    console.log(`✅ Message Bot (${MSG_BOT_USERNAME}@${DOMAIN}) is online and ready to send messages`);
    await messageBot.send(xml("presence"));
  });

  try {
    await messageBot.start();
    console.log(`📨 Message Bot (${MSG_BOT_USERNAME}@${DOMAIN}) started successfully`);
  } catch (error) {
    console.error("❌ Failed to start Message Bot:", error);
    messageBot = null;
    throw error;
  }
}

// Stop Message bot
async function stopMessageBot() {
  if (messageBot) {
    console.log("🛑 Stopping Message Bot...");
    try {
      await messageBot.stop();
      messageBot = null;
      console.log("✅ Message Bot stopped");
    } catch (error) {
      console.error("❌ Error stopping Message Bot:", error);
    }
  }
}

function ensureMessageBotAccount() {
  const jid = `${MSG_BOT_USERNAME}@${DOMAIN}`;
  try {
    console.log(`🔧 Ensuring message bot account exists: ${jid}`);
    runProsodyctlWithPassword("adduser", jid, MSG_BOT_PASSWORD);
    console.log(`✅ Message bot account created: ${jid}`);
  } catch (error) {
    const msg = error?.message || String(error);
    if (msg.includes("already exists") || msg.includes("user already exists") || msg.includes("already registered")) {
      console.log(`ℹ️ Message bot account already exists: ${jid}`);
      try {
        runProsodyctlWithPassword("passwd", jid, MSG_BOT_PASSWORD);
        console.log(`✅ Updated password for message bot account: ${jid}`);
      } catch (passwdError) {
        console.error(`❌ Failed to update password for message bot account:`, passwdError?.message || passwdError);
        throw passwdError;
      }
    } else {
      console.error(`❌ Failed to ensure message bot account:`, msg);
      throw error;
    }
  }
}

/**
 * Convert markdown-formatted AI text to clean plain text for XMPP chat.
 * Handles: bold, italic, headers, bullets, numbered lists, code, horizontal rules.
 */
function markdownToPlainText(text) {
  if (!text) return text;

  let out = text;

  // Remove horizontal rules (--- or ***)
  out = out.replace(/^[-*]{3,}\s*$/gm, '');

  // Convert ### Header / ## Header / # Header -> just the text (uppercase for h1/h2)
  out = out.replace(/^#{1,2}\s+(.+)$/gm, (_, t) => t.toUpperCase());
  out = out.replace(/^#{3,6}\s+(.+)$/gm, (_, t) => t);

  // Remove bold/italic markers (**text**, *text*, __text__, _text_)
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  out = out.replace(/\*(.+?)\*/g, '$1');
  out = out.replace(/___(.+?)___/g, '$1');
  out = out.replace(/__(.+?)__/g, '$1');
  out = out.replace(/_(.+?)_/g, '$1');

  // Convert bullet points (- item / * item) -> "• item"
  out = out.replace(/^[ \t]*[-*]\s+/gm, '• ');

  // Convert numbered lists "1. item" -> keep as-is (already readable)
  // No change needed for numbered lists

  // Remove inline code backticks (`code`) -> just code
  out = out.replace(/`([^`]+)`/g, '$1');

  // Remove code block fences (``` ... ```)
  out = out.replace(/^```[\w]*\n?/gm, '');
  out = out.replace(/^```\s*$/gm, '');

  // Collapse 3+ consecutive blank lines into 2
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}

// Initialize AI bot to listen for incoming messages
async function startAIBot() {
  if (aiBot) {
    console.log("⚠️ AI Bot already running");
    return;
  }

  console.log("🤖 Starting AI Bot...");

  aiBot = client({
    service: XMPP_SERVICE,
    domain: DOMAIN,
    username: BOT_USERNAME,
    password: BOT_PASSWORD,
  });

  aiBot.on("error", (err) => {
    console.error("❌ AI Bot error:", err);
  });

  aiBot.on("status", (status) => {
    console.log(`🤖 AI Bot status: ${status}`);
  });

  aiBot.on("online", async () => {
    console.log("✅ AI Bot is online and listening for messages");
    await aiBot.send(xml("presence"));
  });

  // Listen for incoming messages
  aiBot.on("stanza", async (stanza) => {
    // Only process message stanzas
    if (stanza.is("message")) {
      const from = stanza.attrs.from;
      const type = stanza.attrs.type;
      const bodyElement = stanza.getChild("body");

      // Only respond to chat messages with body content
      if (type === "chat" && bodyElement) {
        const messageText = bodyElement.text();

        // Skip empty messages
        if (!messageText || !messageText.trim()) {
          return;
        }

        // Extract sender JID (remove resource)
        const senderJid = from.split("/")[0];

        // Skip messages from the bot itself
        if (senderJid.startsWith(`${BOT_USERNAME}@`)) {
          return;
        }

        console.log(`📩 Message from ${senderJid}: ${messageText}`);

        try {
          // Get AI response
          console.log(`🤖 Processing with AI...`);
          const aiResponse = await getAIResponse(messageText, senderJid);

          // Convert markdown formatting to plain text for XMPP chat
          const plainResponse = markdownToPlainText(aiResponse);

          // Split large responses into chunks to avoid XMPP stanza size limits
          const MAX_CHUNK = 3000;
          if (plainResponse.length <= MAX_CHUNK) {
            await aiBot.send(
              xml("message", { type: "chat", to: senderJid }, xml("body", {}, plainResponse))
            );
          } else {
            // Split on double-newline (record boundaries) to keep items intact
            const lines = plainResponse.split('\n');
            let chunk = '';
            let chunkIndex = 0;
            for (const line of lines) {
              if (chunk.length + line.length + 1 > MAX_CHUNK) {
                await aiBot.send(
                  xml("message", { type: "chat", to: senderJid }, xml("body", {}, chunk.trim()))
                );
                chunkIndex++;
                chunk = line + '\n';
              } else {
                chunk += line + '\n';
              }
            }
            if (chunk.trim()) {
              await aiBot.send(
                xml("message", { type: "chat", to: senderJid }, xml("body", {}, chunk.trim()))
              );
            }
          }

          console.log(`✅ AI response sent to ${senderJid}`);
        } catch (error) {
          console.error(`❌ Failed to process message from ${senderJid}:`, error.message);

          // Send error message to user
          try {
            await aiBot.send(
              xml(
                "message",
                { type: "chat", to: senderJid },
                xml("body", {}, "Sorry, I encountered an error processing your message. Please try again.")
              )
            );
          } catch (sendError) {
            console.error(`❌ Failed to send error message:`, sendError.message);
          }
        }
      }
    }
  });

  try {
    await aiBot.start();
    console.log("🤖 AI Bot started successfully");
  } catch (error) {
    console.error("❌ Failed to start AI Bot:", error);
    aiBot = null;
  }
}

// Stop AI bot
async function stopAIBot() {
  if (aiBot) {
    console.log("🛑 Stopping AI Bot...");
    try {
      await aiBot.stop();
      aiBot = null;
      console.log("✅ AI Bot stopped");
    } catch (error) {
      console.error("❌ Error stopping AI Bot:", error);
    }
  }
}

// ===== NICKNAME (vCard FN) HELPERS =====

/**
 * Get a user's nickname by logging in as them and fetching their vCard.
 * Returns the FN field from vCard, or null if not set.
 */
async function getUserNickname(username, password) {
  const jid = `${username}@${DOMAIN}`;
  const xmpp = client({
    service: XMPP_SERVICE,
    domain: DOMAIN,
    username,
    password,
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      xmpp.stop().catch(() => {});
      resolve(null);
    }, 8000);

    xmpp.on("error", () => {
      clearTimeout(timeout);
      xmpp.stop().catch(() => {});
      resolve(null);
    });

    xmpp.on("online", async () => {
      try {
        const requestId = `vcard_get_${Date.now()}`;
        const vcardRequest = xml("iq", { type: "get", id: requestId },
          xml("vCard", { xmlns: "vcard-temp" })
        );

        const responsePromise = new Promise((res2, rej2) => {
          const t2 = setTimeout(() => {
            xmpp.removeListener("stanza", onStanza);
            res2(null);
          }, 5000);

          function onStanza(stanza) {
            if (stanza.is("iq") && stanza.attrs.id === requestId) {
              clearTimeout(t2);
              xmpp.removeListener("stanza", onStanza);
              const vcard = stanza.getChild("vCard", "vcard-temp");
              const fn = vcard && vcard.getChildText("FN");
              res2(fn || null);
            }
          }
          xmpp.on("stanza", onStanza);
        });

        await xmpp.send(xml("presence"));
        await xmpp.send(vcardRequest);
        const nickname = await responsePromise;
        clearTimeout(timeout);
        await xmpp.stop();
        resolve(nickname);
      } catch (e) {
        clearTimeout(timeout);
        xmpp.stop().catch(() => {});
        resolve(null);
      }
    });

    xmpp.start().catch(() => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Set a user's nickname by logging in as them and publishing a vCard with FN set.
 */
async function setUserNickname(username, password, nickname) {
  const xmpp = client({
    service: XMPP_SERVICE,
    domain: DOMAIN,
    username,
    password,
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      xmpp.stop().catch(() => {});
      resolve({ success: false, error: "Timeout connecting to XMPP" });
    }, 8000);

    xmpp.on("error", (err) => {
      clearTimeout(timeout);
      xmpp.stop().catch(() => {});
      resolve({ success: false, error: err.message });
    });

    xmpp.on("online", async () => {
      try {
        console.log(`[setNickname:${username}] Online, sending vCard IQ set for nickname="${nickname}"`);
        const requestId = `vcard_set_${Date.now()}`;
        const vcardSet = xml("iq", { type: "set", id: requestId },
          xml("vCard", { xmlns: "vcard-temp" },
            xml("FN", {}, nickname),
            xml("NICKNAME", {}, nickname)
          )
        );

        const responsePromise = new Promise((res2) => {
          const t2 = setTimeout(() => {
            xmpp.removeListener("stanza", onStanza);
            res2({ success: false, error: "Timeout waiting for vCard response" });
          }, 5000);

          function onStanza(stanza) {
            if (stanza.is("iq") && stanza.attrs.id === requestId) {
              clearTimeout(t2);
              xmpp.removeListener("stanza", onStanza);
              console.log(`[setNickname:${username}] vCard IQ response: ${stanza.toString()}`);
              if (stanza.attrs.type === "result") {
                res2({ success: true });
              } else {
                const errEl = stanza.getChild("error");
                res2({ success: false, error: errEl ? errEl.toString() : "vCard set failed" });
              }
            }
          }
          xmpp.on("stanza", onStanza);
        });

        await xmpp.send(xml("presence"));
        await xmpp.send(vcardSet);
        const result = await responsePromise;
        console.log(`[setNickname:${username}] Result: ${JSON.stringify(result)}`);
        if (result.success) { nicknameCache[username] = nickname; saveNicknameCache(nicknameCache); }
        clearTimeout(timeout);
        await xmpp.stop();
        resolve(result);
      } catch (e) {
        clearTimeout(timeout);
        xmpp.stop().catch(() => {});
        resolve({ success: false, error: e.message });
      }
    });

    xmpp.start().catch((e) => {
      clearTimeout(timeout);
      resolve({ success: false, error: e.message });
    });
  });
}

// ---- routes ----
app.get("/", (req, res) => {
  const stats = ProsodyStats.getDashboardStats();
  try {
    const users = listUsers();
    res.render("index", { users, DOMAIN, msg: null, err: null, stats });
  } catch (e) {
    res.render("index", {
      users: [],
      DOMAIN,
      msg: null,
      err:
        "Cannot read Prosody accounts dir. Fix permissions or path.\n\n" +
        (e?.message || String(e)),
      stats,
    });
  }
});

app.post("/users/add", async (req, res) => {
  try {
    const user = safeUsername(req.body.username);
    const pass = (req.body.password || "").trim();
    const nickname = (req.body.nickname || "").trim();
    if (!user) throw new Error("Invalid username. Use letters/numbers/._- only.");
    if (!pass) throw new Error("Password cannot be empty.");

    const jid = `${user}@${DOMAIN}`;
    // Create user (non-interactive)
    runProsodyctlWithPassword("adduser", jid, pass);

    // Set nickname via vCard if provided
    if (nickname) {
      // Small delay to let Prosody register the new account
      await new Promise((r) => setTimeout(r, 800));
      const nickResult = await setUserNickname(user, pass, nickname);
      if (nickResult.success) {
        return res.redirect("/?msg=" + encodeURIComponent(`✅ User created: ${jid} with nickname "${nickname}"`));
      } else {
        // User was created but nickname failed — still a success, just warn
        return res.redirect("/?msg=" + encodeURIComponent(`✅ User created: ${jid} (nickname could not be set: ${nickResult.error})`));
      }
    }

    res.redirect("/?msg=" + encodeURIComponent(`✅ User created: ${jid}`));
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

app.post("/users/passwd", (req, res) => {
  try {
    const user = safeUsername(req.body.username);
    const pass = (req.body.password || "").trim();
    if (!user) throw new Error("Invalid username.");
    if (!pass) throw new Error("Password cannot be empty.");

    const jid = `${user}@${DOMAIN}`;
    runProsodyctlWithPassword("passwd", jid, pass);

    res.redirect(
      "/?msg=" + encodeURIComponent(`✅ Password updated for: ${jid}`)
    );
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

app.post("/users/delete", (req, res) => {
  try {
    const user = safeUsername(req.body.username);
    if (!user) throw new Error("Invalid username.");

    const jid = `${user}@${DOMAIN}`;
    runProsodyctl("deluser", jid);

    res.redirect("/?msg=" + encodeURIComponent(`🗑️ Deleted user: ${jid}`));
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

app.post("/broadcast", async (req, res) => {
  try {
    const text = (req.body.text || "").trim();
    if (!text) throw new Error("Broadcast message cannot be empty.");

    const result = await sendBroadcast(text);
    res.redirect(
      "/?msg=" +
        encodeURIComponent(
          `📣 Broadcast done. Sent=${result.sent}, Failed=${result.failed}, Total=${result.total}`
        )
    );
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

// ===== NEW API ENDPOINTS FOR SENDING MESSAGES AND IMAGES =====

/**
 * Send image with caption to a specific user
 * POST /send-image
 * Body: multipart/form-data with fields: to, image (file), caption
 */
app.post("/send-image", upload.single("image"), async (req, res) => {
  try {
    const { to, caption, messageType } = req.body;
    const imageFile = req.file;

    if (!to || !imageFile) {
      return res.status(400).json({
        success: false,
        error: "Both 'to' and 'image' are required"
      });
    }

    // Validate JID format
    if (!to.includes("@")) {
      return res.status(400).json({
        success: false,
        error: "Invalid JID format. Expected format: username@domain"
      });
    }

    // Check if message bot is running
    if (!messageBot) {
      return res.status(400).json({
        success: false,
        error: "Message bot is not running. Please start the bot first."
      });
    }

    const type = messageType === "groupchat" ? "groupchat" : "chat";

    // Upload file to XMPP HTTP upload service
    console.log(`📤 Uploading ${imageFile.originalname} (${imageFile.size} bytes, ${imageFile.mimetype})`);
    const uploadResult = await uploadFileToXMPP(imageFile.buffer, imageFile.originalname, imageFile.mimetype);

    if (!uploadResult.success) {
      return res.status(500).json({
        success: false,
        error: `File upload failed: ${uploadResult.error}`
      });
    }

    // Send image with caption
    const sendResult = await sendImageWithCaption(to, uploadResult.url, uploadResult.size, caption || "", type);

    if (sendResult.success) {
      res.json({
        success: true,
        message: `Image sent to ${to}`,
        imageUrl: uploadResult.url,
        caption: caption || ""
      });
    } else {
      res.status(500).json({
        success: false,
        error: sendResult.error || "Failed to send image"
      });
    }
  } catch (e) {
    console.error("Error in /send-image:", e);
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

/**
 * Send message to a specific user or group via XMPP
 * POST /send-message
 * Body: { "to": "jid", "message": "Hello!", "messageType": "chat"|"groupchat" }
 */
app.post("/send-message", async (req, res) => {
  try {
    const { to, message, messageType } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Both 'to' and 'message' are required"
      });
    }

    if (!to.includes("@")) {
      return res.status(400).json({
        success: false,
        error: "Invalid JID format. Expected format: username@domain"
      });
    }

    if (!messageBot) {
      return res.status(503).json({
        success: false,
        error: "Message bot is not running. Please start the bot first."
      });
    }

    const isGroup = messageType === "groupchat";
    const result = isGroup
      ? await sendGroupMessage(to, message)
      : await sendMessageToUser(to, message);

    if (result.success) {
      res.json({ success: true, message: `Message sent to ${to}` });
    } else {
      res.status(500).json({ success: false, error: result.error || "Failed to send message" });
    }
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// Get list of users (API endpoint)
app.get("/users/list", (req, res) => {
  try {
    const users = listUsers().map((u) => `${u}@${DOMAIN}`);
    res.json({
      success: true,
      users: users,
      total: users.length
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// Persistent nickname cache — survives server restarts.
// Written to disk on every successful setUserNickname call.
const NICKNAME_CACHE_FILE = `${__dirname}/nickname_cache.json`;

function loadNicknameCache() {
  try {
    if (fs.existsSync(NICKNAME_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(NICKNAME_CACHE_FILE, "utf8"));
    }
  } catch (_) {}
  return {};
}

function saveNicknameCache(cache) {
  try {
    fs.writeFileSync(NICKNAME_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (_) {}
}

const nicknameCache = loadNicknameCache();

// Prosody data root
const PROSODY_ROOT = `/var/lib/prosody/chat%2ethirupathybright%2ein`;
const PEP_NICK_DIR   = `${PROSODY_ROOT}/pep_http%3a%2f%2fjabber%2eorg%2fprotocol%2fnick`;
const PEP_VCARD4_DIR = `${PROSODY_ROOT}/pep_urn%3axmpp%3avcard4`;
const PEP_BOOKMARKS_DIR = `${PROSODY_ROOT}/pep_urn%3axmpp%3abookmarks%3a1`;
const PEP_NODES_DIR = `${PROSODY_ROOT}/pep`;

// Besides the per-node item-storage files (PEP_BOOKMARKS_DIR etc.), Prosody
// keeps a separate per-user PEP *node registry* at PEP_NODES_DIR/<user>.dat
// that records which pubsub nodes the user owns and their config. A client
// only ever gets served items for a node that's registered here — appending
// to a *_DIR/<user>.list file for a node prosody doesn't know about is inert.
// For any account that has logged in and published/received a bookmark
// before, this node already exists (their client created it). But for a
// brand-new or just-recreated account, it doesn't yet, and addMucBookmark's
// file append would silently do nothing until the user's own client
// happened to create the node itself. This ensures the node exists first,
// using the exact same config Prosody itself writes for it.
function ensurePepBookmarksNode(username) {
  const filePath = `${PEP_NODES_DIR}/${username}.dat`;
  execFileSync("sudo", ["-n", "install", "-d", "-o", "prosody", "-g", "prosody", "-m", "750", PEP_NODES_DIR]);

  let content = "";
  try {
    content = execFileSync("sudo", ["-n", "cat", filePath], { encoding: "utf8" });
  } catch (e) {
    content = "return {\n};\n";
  }

  if (content.includes('["urn:xmpp:bookmarks:1"]')) return; // already registered

  const nodeBlock =
    `\t["urn:xmpp:bookmarks:1"] = {\n` +
    `\t\t["subscribers"] = {};\n` +
    `\t\t["name"] = "urn:xmpp:bookmarks:1";\n` +
    `\t\t["config"] = {\n` +
    `\t\t\t["persist_items"] = true;\n` +
    `\t\t\t["send_last_published_item"] = "never";\n` +
    `\t\t\t["notify_retract"] = true;\n` +
    `\t\t\t["notify_delete"] = true;\n` +
    `\t\t\t["access_model"] = "whitelist";\n` +
    `\t\t\t["max_items"] = "max";\n` +
    `\t\t};\n` +
    `\t\t["affiliations"] = {};\n` +
    `\t};\n`;

  // Insert just before the final top-level closing `};` so this stays a
  // simple, targeted insert rather than a full Lua parse/rewrite.
  const lastBrace = content.lastIndexOf("};");
  if (lastBrace === -1) throw new Error(`Unexpected format in ${filePath}, refusing to edit`);
  const updated = content.slice(0, lastBrace) + nodeBlock + content.slice(lastBrace);

  execFileSync("sudo", ["-n", "tee", filePath], { input: updated, encoding: "utf8" });
  execFileSync("sudo", ["-n", "chown", "prosody:prosody", filePath]);
  execFileSync("sudo", ["-n", "chmod", "640", filePath]);
}

// Debounced reload of Prosody's pep module so freshly written bookmark files
// are actually served; then disconnect affected users so apps refetch.
let pepReloadTimer = null;
const pepReloadPending = new Set();
function schedulePepReload(memberJid) {
  if (memberJid) pepReloadPending.add(memberJid);
  if (pepReloadTimer) clearTimeout(pepReloadTimer);
  pepReloadTimer = setTimeout(() => {
    pepReloadTimer = null;
    const jids = [...pepReloadPending];
    pepReloadPending.clear();
    try {
      runProsodyctlShell(`module:reload("pep", "${DOMAIN}")
`);
    } catch (e) {
      console.warn(`⚠️ Could not reload pep module: ${e?.message || e}`);
    }
    for (const jid of jids) {
      try {
        runProsodyctlShell(`return c2s:close("${jid.replace(/"/g, '\\"')}")
`);
      } catch (e) {
        console.warn(`⚠️ Could not force-reconnect ${jid}: ${e?.message || e}`);
      }
    }
  }, 1500);
}

// Add a MUC bookmark (XEP-0402) so a newly-added group member sees the group
// in their chat app's group list without having to manually join it first.
// Server-side room membership (affiliation) and client-side bookmarks are
// two separate things in XMPP — adding someone as a member does NOT make
// their app show the group; a bookmark is what does that.
//
// Prosody's PEP item-storage files are an append-only log: each `item({...})`
// block is one record, and later ones with the same `key` shadow earlier ones
// on read. Appending a new item is therefore safe to do while the server is
// running — it can't corrupt existing data, and at worst races a concurrent
// write from the same user's own client (rare, and self-healing on their
// next bookmark save).
function addMucBookmark(memberJid, roomJid, roomName) {
  const username = memberJid.split("@")[0];
  ensurePepBookmarksNode(username);
  const filePath = `${PEP_BOOKMARKS_DIR}/${username}.list`;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const roomJidEsc = roomJid.replace(/"/g, '\\"');
  const roomNameEsc = (roomName || roomJid.split("@")[0]).replace(/"/g, '\\"');
  const memberJidEsc = memberJid.replace(/"/g, '\\"');

  const item = `item({\n` +
    `\t["key"] = "${roomJidEsc}";\n` +
    `\t["when"] = ${nowEpoch};\n` +
    `\t["attr"] = {\n` +
    `\t\t["xmlns"] = "urn:xmpp:bookmarks:1";\n` +
    `\t\t["name"] = "${roomNameEsc}";\n` +
    `\t\t["stamp"] = "${stamp}";\n` +
    `\t\t["autojoin"] = "1";\n` +
    `\t};\n` +
    `\t["name"] = "conference";\n` +
    `\t["with"] = "${memberJidEsc}";\n` +
    `});\n`;

  // The PEP data directory is owned by the prosody user (0750), so the
  // dashboard's own process (running as ubuntu) can't write there directly
  // — write via sudo instead. New files are created 0640 prosody:prosody to
  // match Prosody's own file layout.
  execFileSync("sudo", ["-n", "install", "-d", "-o", "prosody", "-g", "prosody", "-m", "750", PEP_BOOKMARKS_DIR]);
  execFileSync("sudo", ["-n", "tee", "-a", filePath], { input: item, encoding: "utf8" });
  execFileSync("sudo", ["-n", "chown", "prosody:prosody", filePath]);
  execFileSync("sudo", ["-n", "chmod", "640", filePath]);

  // Prosody caches each user's PEP service in memory, so the files written
  // above are ignored (item-not-found) until the pep module is reloaded.
  // Reload it (debounced for bulk adds), then kick the user so their app
  // reconnects and re-reads the bookmarks.
  schedulePepReload(memberJid);
}

// Remove a MUC bookmark. Unlike addMucBookmark this can't just append —
// the append-only "last item for a key wins" format has no protocol-level
// tombstone we can rely on here, so instead: read the whole log, drop every
// item({...}) block whose key matches this room, and overwrite the file with
// what's left. Safe because we parse with the same brace-matching approach
// used elsewhere in this file (extractTopLevelBlocks) rather than a fragile
// regex, so a room name/JID containing "});" etc. can't break the split.
function removeMucBookmark(memberJid, roomJid) {
  const username = memberJid.split("@")[0];
  const filePath = `${PEP_BOOKMARKS_DIR}/${username}.list`;
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  const keyNeedle = `["key"] = "${roomJid}";`;

  // Each record is `item(` + one top-level {...} block + `);`. Reuse the
  // existing brace-matcher to find each block's extent, then keep only the
  // ones that don't reference this room.
  const blocks = extractTopLevelBlocks(content);
  let rebuilt = "";
  let cursor = 0;
  for (const block of blocks) {
    const blockStart = content.indexOf(block, cursor);
    const prefixStart = content.lastIndexOf("item(", blockStart);
    const afterBlock = blockStart + block.length;
    const suffixEnd = content.indexOf(";", afterBlock) + 1; // include the trailing `);`
    const fullRecord = content.slice(prefixStart, suffixEnd);
    if (!block.includes(keyNeedle)) {
      rebuilt += fullRecord + "\n";
    }
    cursor = suffixEnd;
  }

  execFileSync("sudo", ["-n", "tee", filePath], { input: rebuilt, encoding: "utf8" });
  execFileSync("sudo", ["-n", "chown", "prosody:prosody", filePath]);
  execFileSync("sudo", ["-n", "chmod", "640", filePath]);
  schedulePepReload(memberJid);
}

// When a whole group is deleted, every member who had it bookmarked is left
// with a broken/ghost entry in their chat app forever unless we go find and
// strip it from each of them — removeMucBookmark only handles one user at a
// time (the normal remove-a-single-member case), this does all of them.
function removeMucBookmarkFromAllUsers(roomJid) {
  let usernames;
  try {
    usernames = fs.readdirSync(PEP_BOOKMARKS_DIR)
      .filter((f) => f.endsWith(".list"))
      .map((f) => f.replace(/\.list$/, ""));
  } catch (_) {
    return 0; // directory doesn't exist yet — nothing to clean
  }

  const keyNeedle = `["key"] = "${roomJid}";`;
  let cleaned = 0;
  for (const username of usernames) {
    const filePath = `${PEP_BOOKMARKS_DIR}/${username}.list`;
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      continue;
    }
    if (!content.includes(keyNeedle)) continue;

    removeMucBookmark(`${username}@${DOMAIN}`, roomJid);
    cleaned++;
  }
  return cleaned;
}

// Extract all top-level balanced brace blocks from a Lua string.
function extractTopLevelBlocks(content) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (content[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

// Extract a string value from a Lua block identified by ["name"] = "blockName".
// Works with nested braces (e.g. ["attr"] = {} inside the block).
function extractLuaBlockValue(content, blockName) {
  const nameTag = `["name"] = "${blockName}"`;
  for (const block of extractTopLevelBlocks(content)) {
    if (!block.includes(nameTag)) continue;
    // Find the first inner sub-block (the value container), then grab its first quoted string
    const innerBlocks = extractTopLevelBlocks(block.slice(1, -1));
    for (const inner of innerBlocks) {
      // The value string appears before any ["name"] key inside the inner block
      const valMatch = inner.match(/^\s*\{\s*"([^"]+)"/s);
      if (valMatch && valMatch[1].trim()) return valMatch[1].trim();
    }
  }
  return null;
}

function readNicknameFromDisk(username) {
  // 1. Try vCard4 PEP node (urn:xmpp:vcard4)
  try {
    const vcard4Path = `${PEP_VCARD4_DIR}/${username}.list`;
    if (fs.existsSync(vcard4Path)) {
      const content = fs.readFileSync(vcard4Path, "utf8");
      // Try fn block first, then nickname block
      const val = extractLuaBlockValue(content, "fn") || extractLuaBlockValue(content, "nickname");
      if (val) {
        if (nicknameCache[username] !== val) { nicknameCache[username] = val; saveNicknameCache(nicknameCache); }
        return val;
      }
    }
  } catch (_) {}

  // 2. Try PEP nick node (http://jabber.org/protocol/nick)
  try {
    const pepNickPath = `${PEP_NICK_DIR}/${username}.list`;
    if (fs.existsSync(pepNickPath)) {
      const content = fs.readFileSync(pepNickPath, "utf8");
      const val = extractLuaBlockValue(content, "nick");
      if (val) {
        if (nicknameCache[username] !== val) { nicknameCache[username] = val; saveNicknameCache(nicknameCache); }
        return val;
      }
    }
  } catch (_) {}

  // 3. Fallback: cache (set immediately on dashboard nickname update)
  if (nicknameCache[username]) return nicknameCache[username];

  return "";
}

// Get list of users with their stored nicknames from vCard files on disk
app.get("/users/list-with-nicknames", (req, res) => {
  try {
    const usernames = listUsers();
    const result = usernames.map((u) => ({
      username: u,
      jid: `${u}@${DOMAIN}`,
      nickname: readNicknameFromDisk(u),
    }));
    res.json({ success: true, users: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Debug: show raw PEP nick file contents to verify parsing format
app.get("/debug/vcards", (req, res) => {
  try {
    const info = {
      pepNickDir: PEP_NICK_DIR,
      pepNickDirExists: fs.existsSync(PEP_NICK_DIR),
      pepNickFiles: {},
      pepVcard4Dir: PEP_VCARD4_DIR,
      pepVcard4DirExists: fs.existsSync(PEP_VCARD4_DIR),
      pepVcard4Files: {},
    };

    if (info.pepNickDirExists) {
      for (const f of fs.readdirSync(PEP_NICK_DIR)) {
        try {
          info.pepNickFiles[f] = fs.readFileSync(`${PEP_NICK_DIR}/${f}`, "utf8").slice(0, 500);
        } catch (e) { info.pepNickFiles[f] = `ERROR: ${e.message}`; }
      }
    }

    if (info.pepVcard4DirExists) {
      for (const f of fs.readdirSync(PEP_VCARD4_DIR)) {
        try {
          info.pepVcard4Files[f] = fs.readFileSync(`${PEP_VCARD4_DIR}/${f}`, "utf8").slice(0, 500);
        } catch (e) { info.pepVcard4Files[f] = `ERROR: ${e.message}`; }
      }
    }

    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start AI Bot route
app.post("/ai-bot/start", async (req, res) => {
  try {
    await startAIBot();
    res.redirect("/?msg=" + encodeURIComponent("🤖 AI Bot started successfully"));
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

// Stop AI Bot route
app.post("/ai-bot/stop", async (req, res) => {
  try {
    await stopAIBot();
    res.redirect("/?msg=" + encodeURIComponent("🛑 AI Bot stopped"));
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

// Get AI Bot status
app.get("/ai-bot/status", (req, res) => {
  res.json({
    running: aiBot !== null,
    status: aiBot ? "online" : "offline"
  });
});

// Start Message Bot route
app.post("/message-bot/start", async (req, res) => {
  try {
    await startMessageBot();
    res.redirect("/?msg=" + encodeURIComponent("📨 Message Bot started successfully"));
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

// Stop Message Bot route
app.post("/message-bot/stop", async (req, res) => {
  try {
    await stopMessageBot();
    res.redirect("/?msg=" + encodeURIComponent("🛑 Message Bot stopped"));
  } catch (e) {
    res.redirect("/?err=" + encodeURIComponent(e?.message || String(e)));
  }
});

// Get Message Bot status
app.get("/message-bot/status", (req, res) => {
  res.json({
    running: messageBot !== null,
    status: messageBot ? "online" : "offline"
  });
});

// Get both bots status
app.get("/bots/status", (req, res) => {
  res.json({
    aiBot: {
      running: aiBot !== null,
      status: aiBot ? "online" : "offline"
    },
    messageBot: {
      running: messageBot !== null,
      status: messageBot ? "online" : "offline"
    }
  });
});

// ===== MARKETING PERSON MANAGEMENT ENDPOINTS =====

// Get all unique marketing persons from database
app.get("/marketing-persons", async (req, res) => {
  try {
    const result = await DatabaseHelper.getUniqueMarketingPersons();
    res.json(result);
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// Get all marketing person assignments
app.get("/marketing-persons/assignments", (req, res) => {
  try {
    const assignments = MarketingPersonStore.getAllAssignments();
    const users = listUsers().map((u) => `${u}@${DOMAIN}`);

    res.json({
      success: true,
      assignments: assignments,
      users: users
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// Assign marketing person(s) to a user
app.post("/marketing-persons/assign", (req, res) => {
  try {
    const { userJid, marketingPersons } = req.body;

    if (!userJid || !marketingPersons) {
      return res.status(400).json({
        success: false,
        error: "userJid and marketingPersons are required"
      });
    }

    // Accept both single value and array
    const personsArray = Array.isArray(marketingPersons) ? marketingPersons : [marketingPersons];

    if (personsArray.length === 0) {
      return res.status(400).json({
        success: false,
        error: "At least one marketing person must be provided"
      });
    }

    MarketingPersonStore.setMarketingPersons(userJid, personsArray);

    res.json({
      success: true,
      message: `Assigned ${personsArray.join(', ')} to ${userJid}`
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// Remove marketing person assignment from a user
app.post("/marketing-persons/remove", (req, res) => {
  try {
    const { userJid } = req.body;

    if (!userJid) {
      return res.status(400).json({
        success: false,
        error: "userJid is required"
      });
    }

    const removed = MarketingPersonStore.removeMarketingPerson(userJid);

    if (removed) {
      res.json({
        success: true,
        message: `Removed marketing person assignment for ${userJid}`
      });
    } else {
      res.json({
        success: false,
        message: `No assignment found for ${userJid}`
      });
    }
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// Get marketing person for a specific user
app.get("/marketing-persons/user/:userJid", (req, res) => {
  try {
    const { userJid } = req.params;
    const marketingPerson = MarketingPersonStore.getMarketingPerson(userJid);

    res.json({
      success: true,
      userJid: userJid,
      marketingPerson: marketingPerson
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e?.message || String(e)
    });
  }
});

// ===== MUC (Group) MANAGEMENT =====
// Uses the messageBot's XMPP connection to send proper MUC IQ stanzas
// (create/config/affiliation/destroy) per XEP-0045, rather than shelling out.
//
// PERMANENT_ADMIN is always granted the "owner" affiliation on every group —
// on creation and whenever a member is added (self-healing if it was ever
// removed by someone else).

const MUC_DOMAIN = `conference.${DOMAIN}`;
const PERMANENT_ADMIN = "7550300724@chat.thirupathybright.in";

// Date.now() alone collides when multiple IQs are built in the same
// millisecond (e.g. Promise.all firing 3 requests at once) — every listener
// then matches the same stanza.attrs.id and all resolve with the first
// response that arrives, silently returning wrong data for the others.
let _mucIdCounter = 0;
function uniqueMucId(prefix) {
  _mucIdCounter += 1;
  return `${prefix}_${Date.now()}_${_mucIdCounter}`;
}

// List all MUC rooms via `prosodyctl shell` (muc:list). Unlike disco#items,
// this sees hidden/members-only rooms too (e.g. the real "Tbi Team Report"
// group) — disco#items only returns publicly-listed rooms, which silently
// dropped it. Destroyed rooms leave an inert tombstone file behind, so we
// filter those out using each room's `_data.destroyed` flag.
function runProsodyctlShell(script) {
  try {
    return execFileSync("sudo", ["-n", "prosodyctl", "shell"], {
      input: script,
      encoding: "utf8",
      timeout: 15000,
    });
  } catch (sudoErr) {
    const sudoMessage = buildExecError(sudoErr);
    try {
      return execFileSync("prosodyctl", ["shell"], {
        input: script,
        encoding: "utf8",
        timeout: 15000,
      });
    } catch (plainErr) {
      const plainMessage = buildExecError(plainErr);
      throw new Error(`Failed to run prosodyctl shell with sudo: ${sudoMessage}\nWithout sudo: ${plainMessage}`);
    }
  }
}

// Parse `| some text` result lines out of prosodyctl shell's console output.
// Real result lines start with "| " at column 0 (no leading whitespace);
// the ASCII-art banner also contains "|" characters but always has leading
// indentation, so checking the RAW (untrimmed) line prefix distinguishes them.
// Also skips the trailing "| OK: N rooms" summary line.
function parseShellListLines(output) {
  return output
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| OK:"))
    .map((l) => l.slice(2).trim());
}

async function listMucRooms() {
  const listOutput = runProsodyctlShell(`muc:list("${MUC_DOMAIN}")\n`);
  const jids = parseShellListLines(listOutput);
  if (jids.length === 0) return [];

  // One combined script: for each room, return "D" if destroyed, else its name.
  const script = jids
    .map((jid) => {
      const esc = jid.replace(/"/g, '\\"');
      return `return muc:room("${esc}")._data.destroyed and "D" or (muc:room("${esc}")._data.name or "${esc.split("@")[0]}")\n`;
    })
    .join("");
  const infoOutput = runProsodyctlShell(script);
  const results = parseShellListLines(infoOutput).filter((l) => l.startsWith("Result: "));
  const names = results.map((l) => l.slice("Result: ".length));

  const rooms = [];
  for (let i = 0; i < jids.length; i++) {
    if (names[i] === "D") continue; // tombstone — skip
    rooms.push({ jid: jids[i], name: names[i] || jids[i].split("@")[0] });
  }
  return rooms;
}

// Create a new persistent, public MUC room and grant PERMANENT_ADMIN owner.
async function createMucRoom(roomLocalPart, roomName) {
  if (!messageBot) throw new Error("Message bot is not running. Please start the bot first.");

  const roomJid = `${roomLocalPart}@${MUC_DOMAIN}`;
  const nickname = MSG_BOT_USERNAME;
  const roomWithNick = `${roomJid}/${nickname}`;

  // Step 1: join as bot to trigger room creation (bot becomes owner by default)
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      messageBot.removeListener("stanza", onPresence);
      resolve();
    }, 5000);

    function onPresence(stanza) {
      if (stanza.is("presence") && stanza.attrs.from && stanza.attrs.from.startsWith(roomJid + "/")) {
        clearTimeout(timeout);
        messageBot.removeListener("stanza", onPresence);
        resolve();
      }
    }
    messageBot.on("stanza", onPresence);
    messageBot.send(
      xml("presence", { to: roomWithNick }, xml("x", { xmlns: "http://jabber.org/protocol/muc" }))
    );
  });

  // Step 2: submit room configuration (name, persistent, public)
  const configRequestId = uniqueMucId("muc_config");
  const configForm = xml(
    "iq",
    { type: "set", to: roomJid, id: configRequestId },
    xml("query", { xmlns: "http://jabber.org/protocol/muc#owner" },
      xml("x", { xmlns: "jabber:x:data", type: "submit" },
        xml("field", { var: "FORM_TYPE" }, xml("value", {}, "http://jabber.org/protocol/muc#roomconfig")),
        xml("field", { var: "muc#roomconfig_roomname" }, xml("value", {}, roomName || roomLocalPart)),
        xml("field", { var: "muc#roomconfig_persistentroom" }, xml("value", {}, "1")),
        xml("field", { var: "muc#roomconfig_publicroom" }, xml("value", {}, "1")),
        // Without this, the room has no real access control: anyone can
        // join and send messages regardless of the affiliation list, so
        // removing a member here wouldn't actually revoke their access —
        // matches okipamom's existing (working) configuration.
        xml("field", { var: "muc#roomconfig_membersonly" }, xml("value", {}, "1")),
      )
    )
  );

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      messageBot.removeListener("stanza", onStanza);
      reject(new Error("Timeout configuring room"));
    }, 8000);

    function onStanza(stanza) {
      if (stanza.is("iq") && stanza.attrs.id === configRequestId) {
        clearTimeout(timeout);
        messageBot.removeListener("stanza", onStanza);
        if (stanza.attrs.type === "result") resolve();
        else reject(new Error("Failed to configure room"));
      }
    }
    messageBot.on("stanza", onStanza);
    messageBot.send(configForm);
  });

  // Step 3: grant PERMANENT_ADMIN owner affiliation
  await setMucAffiliation(roomJid, PERMANENT_ADMIN, "owner");

  // Step 4: bot leaves (it doesn't need to stay in every group)
  await messageBot.send(xml("presence", { to: roomWithNick, type: "unavailable" }));

  return { roomJid };
}

// Set a member/owner/admin affiliation on a room.
// Uses `prosodyctl shell` (server-side admin power) instead of an XMPP IQ
// stanza — the IQ approach only works if the bot itself already holds
// owner/admin rights in that specific room, which fails for rooms created
// before this dashboard existed or by someone else entirely (see: "Only
// owners can configure rooms" errors on rooms like a revived old tombstone).
async function setMucAffiliation(roomJid, memberJid, affiliation) {
  // Every line sent to `prosodyctl shell` is executed as its own separate
  // REPL command — `local` variables do NOT persist across lines. Must be
  // a single expression using `and`/`or` instead of multi-statement Lua.
  const jidEsc = roomJid.replace(/"/g, '\\"');
  const memberEsc = memberJid.replace(/"/g, '\\"');
  const affEsc = affiliation === "none" ? "nil" : `"${affiliation.replace(/"/g, '\\"')}"`;
  const script = `return (muc:room("${jidEsc}"):set_affiliation(true, "${memberEsc}", ${affEsc})) and "OK" or "FAIL"\n`;
  const output = runProsodyctlShell(script);
  const [result] = parseShellListLines(output).filter((l) => l.startsWith("Result: "));
  const value = result ? result.slice("Result: ".length) : "";
  if (value !== "OK") throw new Error(`Failed to set affiliation for ${memberJid} in ${roomJid} (got: ${value || "no response"})`);
}

// Get the affiliation list for a room (owners/members/admins) via muc#admin IQ.
async function getMucAffiliations(roomJid, affiliation) {
  if (!messageBot) throw new Error("Message bot is not running. Please start the bot first.");

  const requestId = uniqueMucId("muc_aff_list");
  const request = xml(
    "iq",
    { type: "get", to: roomJid, id: requestId },
    xml("query", { xmlns: "http://jabber.org/protocol/muc#admin" },
      xml("item", { affiliation })
    )
  );

  const responsePromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      messageBot.removeListener("stanza", onStanza);
      resolve([]);
    }, 5000);

    function onStanza(stanza) {
      if (stanza.is("iq") && stanza.attrs.id === requestId) {
        clearTimeout(timeout);
        messageBot.removeListener("stanza", onStanza);
        if (stanza.attrs.type === "result") {
          const query = stanza.getChild("query");
          const items = query ? query.getChildren("item") : [];
          resolve(items.map((item) => item.attrs.jid));
        } else {
          resolve([]);
        }
      }
    }
    messageBot.on("stanza", onStanza);
  });

  await messageBot.send(request);
  return responsePromise;
}

// Destroy a MUC room permanently.
// Destroy a MUC room permanently. Uses `prosodyctl shell` for the same
// reason as setMucAffiliation — an IQ-based destroy only works if the bot
// itself is owner, which isn't true for rooms it didn't create.
async function destroyMucRoom(roomJid, reason) {
  const jidEsc = roomJid.replace(/"/g, '\\"');
  const reasonEsc = (reason || "Room removed by admin").replace(/"/g, '\\"');
  const script = `return (muc:room("${jidEsc}"):destroy(nil, "${reasonEsc}")) and "OK" or "FAIL"\n`;
  const output = runProsodyctlShell(script);
  const [result] = parseShellListLines(output).filter((l) => l.startsWith("Result: "));
  const value = result ? result.slice("Result: ".length) : "";
  if (value !== "OK") throw new Error(`Failed to destroy room ${roomJid} (got: ${value || "no response"})`);
}

// ---- routes ----

// List all groups with member counts.
app.get("/groups/list", async (req, res) => {
  try {
    const rooms = await listMucRooms();
    const withCounts = [];
    // Sequential per room, and sequential per affiliation within each room —
    // avoids relying solely on uniqueMucId() for correctness when many IQs
    // to the same room could otherwise land in the same event-loop tick.
    for (const r of rooms) {
      try {
        const owners = await getMucAffiliations(r.jid, "owner");
        const admins = await getMucAffiliations(r.jid, "admin");
        const members = await getMucAffiliations(r.jid, "member");
        const uniqueCount = new Set([...owners, ...admins, ...members]).size;
        withCounts.push({ jid: r.jid, name: r.name, memberCount: uniqueCount });
      } catch (_) {
        withCounts.push({ jid: r.jid, name: r.name, memberCount: null });
      }
    }
    res.json({ success: true, groups: withCounts });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Get members (owners/admins/members) of a single group.
app.get("/groups/members", async (req, res) => {
  try {
    const roomJid = (req.query.jid || "").trim();
    if (!roomJid) throw new Error("jid query param is required");

    // Sequential, not Promise.all: three IQs to the same room in the same
    // tick previously collided on request IDs and all resolved with the
    // same (wrong) response. uniqueMucId() fixed the collision, but keeping
    // these sequential avoids relying on that alone for correctness here.
    const owners = await getMucAffiliations(roomJid, "owner");
    const admins = await getMucAffiliations(roomJid, "admin");
    const members = await getMucAffiliations(roomJid, "member");

    const withNickname = (jids) => jids.map((jid) => {
      const username = jid.split("@")[0];
      return { jid, nickname: readNicknameFromDisk(username) || "" };
    });

    res.json({
      success: true,
      owners: withNickname(owners),
      admins: withNickname(admins),
      members: withNickname(members),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Create a new group. PERMANENT_ADMIN is always made owner.
app.post("/groups/create", async (req, res) => {
  try {
    // JID local-parts are normalized to lowercase by the XMPP server (nodeprep)
    // regardless of what's sent — lowercasing here up front means the roomJid
    // we build and return always matches what Prosody actually creates.
    // Mismatched case previously caused "Failed to set affiliation ... no
    // response" because later calls queried a JID the room didn't exist under.
    const roomLocalPart = safeUsername((req.body.roomId || "").toLowerCase());
    const roomName = (req.body.name || "").trim();
    if (!roomLocalPart) throw new Error("Invalid group ID. Use letters/numbers/._- only.");
    if (!roomName) throw new Error("Group name is required.");

    const { roomJid } = await createMucRoom(roomLocalPart, roomName);
    res.json({ success: true, message: `Group created: ${roomJid}`, jid: roomJid });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Delete (destroy) a group.
app.post("/groups/delete", async (req, res) => {
  try {
    const roomJid = (req.body.jid || "").trim();
    if (!roomJid || !roomJid.includes("@")) throw new Error("Valid group JID is required.");

    await destroyMucRoom(roomJid, "Deleted by admin via dashboard");

    // Destroying the room server-side leaves anyone who'd bookmarked it with
    // a permanently broken/ghost entry in their chat app — strip it from
    // everyone, not just whoever the dashboard happens to think was a member.
    let bookmarksCleaned = 0;
    try {
      bookmarksCleaned = removeMucBookmarkFromAllUsers(roomJid);
    } catch (bookmarkErr) {
      console.error(`Failed to sweep bookmarks for deleted group ${roomJid}:`, bookmarkErr.message);
    }

    res.json({
      success: true,
      message: `Group deleted: ${roomJid}${bookmarksCleaned ? ` (removed from ${bookmarksCleaned} user${bookmarksCleaned > 1 ? "s'" : "'s"} bookmarks)` : ""}`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Add a member to a group. Always re-asserts PERMANENT_ADMIN as owner too.
app.post("/groups/add-member", async (req, res) => {
  try {
    const roomJid = (req.body.jid || "").trim();
    const memberJid = (req.body.memberJid || "").trim();
    const affiliation = (req.body.affiliation || "member").trim();

    if (!roomJid || !roomJid.includes("@")) throw new Error("Valid group JID is required.");
    if (!memberJid || !memberJid.includes("@")) throw new Error("Valid member JID is required.");
    if (!["member", "admin", "owner"].includes(affiliation)) throw new Error("Invalid affiliation.");

    await setMucAffiliation(roomJid, memberJid, affiliation);

    // Always keep the permanent admin as owner, regardless of who else was just added.
    if (memberJid !== PERMANENT_ADMIN) {
      await setMucAffiliation(roomJid, PERMANENT_ADMIN, "owner");
    }

    // Give the member a bookmark so the group shows up in their chat app
    // automatically — being a room member alone doesn't do that (see
    // addMucBookmark for why). Best-effort: a failure here shouldn't fail
    // the whole request, since the person IS a real member either way.
    try {
      const roomJidEsc = roomJid.replace(/"/g, '\\"');
      const nameOutput = runProsodyctlShell(`return muc:room("${roomJidEsc}")._data.name\n`);
      const [nameResult] = parseShellListLines(nameOutput).filter((l) => l.startsWith("Result: "));
      const roomName = nameResult ? nameResult.slice("Result: ".length) : roomJid.split("@")[0];
      addMucBookmark(memberJid, roomJid, roomName === "nil" ? roomJid.split("@")[0] : roomName);
    } catch (bookmarkErr) {
      console.error(`Failed to add bookmark for ${memberJid} on ${roomJid}:`, bookmarkErr.message);
    }

    res.json({ success: true, message: `${memberJid} added to ${roomJid} as ${affiliation}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Remove a member from a group (sets affiliation to "none"). Blocks removing the permanent admin.
app.post("/groups/remove-member", async (req, res) => {
  try {
    const roomJid = (req.body.jid || "").trim();
    const memberJid = (req.body.memberJid || "").trim();

    if (!roomJid || !roomJid.includes("@")) throw new Error("Valid group JID is required.");
    if (!memberJid || !memberJid.includes("@")) throw new Error("Valid member JID is required.");
    if (memberJid === PERMANENT_ADMIN) throw new Error(`${PERMANENT_ADMIN} is the permanent admin and cannot be removed.`);

    await setMucAffiliation(roomJid, memberJid, "none");

    // Also drop their bookmark — otherwise their app keeps showing a group
    // they can no longer actually join (confusing, and the whole point of
    // "remove" is that it disappears for them). Best-effort like the add path.
    try {
      removeMucBookmark(memberJid, roomJid);
    } catch (bookmarkErr) {
      console.error(`Failed to remove bookmark for ${memberJid} on ${roomJid}:`, bookmarkErr.message);
    }

    res.json({ success: true, message: `${memberJid} removed from ${roomJid}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// ===== NICKNAME API ENDPOINTS =====

/**
 * GET /users/nickname/:username
 * Get a user's nickname. Requires their current password to log in and fetch vCard.
 * Query param: ?password=xxx
 */
app.get("/users/nickname/:username", async (req, res) => {
  try {
    const user = safeUsername(req.params.username);
    const pass = (req.query.password || "").trim();

    if (!user) return res.status(400).json({ success: false, error: "Invalid username" });
    if (!pass) return res.status(400).json({ success: false, error: "Password is required to fetch vCard" });

    const nickname = await getUserNickname(user, pass);
    res.json({ success: true, username: user, nickname: nickname || "" });
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

/**
 * POST /users/nickname
 * Set a user's nickname (FN in vCard).
 * Body: { username, password, nickname }
 * The password is used to authenticate as the user to publish the vCard.
 * If you want to reset the password first, use /users/passwd before this.
 */
app.post("/users/nickname", async (req, res) => {
  try {
    const user = safeUsername(req.body.username);
    const pass = (req.body.password || "").trim();
    const nickname = (req.body.nickname || "").trim();

    if (!user) return res.status(400).json({ success: false, error: "Invalid username" });
    if (!pass) return res.status(400).json({ success: false, error: "Password is required" });
    if (!nickname) return res.status(400).json({ success: false, error: "Nickname cannot be empty" });

    const result = await setUserNickname(user, pass, nickname);
    if (result.success) {
      res.json({ success: true, message: `Nickname set to "${nickname}" for ${user}@${DOMAIN}` });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

/**
 * POST /users/nickname/with-reset
 * Admin convenience: reset the user's password to a temp value, set the vCard nickname,
 * and leave the password as the new value.
 * Body: { username, newPassword, nickname }
 */
app.post("/users/nickname/with-reset", async (req, res) => {
  try {
    const user = safeUsername(req.body.username);
    const newPass = (req.body.newPassword || "").trim();
    const nickname = (req.body.nickname || "").trim();

    if (!user) return res.status(400).json({ success: false, error: "Invalid username" });
    if (!newPass) return res.status(400).json({ success: false, error: "New password is required" });
    if (!nickname) return res.status(400).json({ success: false, error: "Nickname cannot be empty" });

    const jid = `${user}@${DOMAIN}`;

    // Step 1: Reset password via prosodyctl
    runProsodyctlWithPassword("passwd", jid, newPass);

    // Step 2: Small delay to let Prosody flush the new password
    await new Promise((r) => setTimeout(r, 800));

    // Step 3: Log in as user and set vCard nickname
    const result = await setUserNickname(user, newPass, nickname);
    if (result.success) {
      res.json({
        success: true,
        message: `Nickname set to "${nickname}" for ${jid}. Password was also updated to the provided value.`
      });
    } else {
      res.status(500).json({ success: false, error: `Password reset succeeded but vCard failed: ${result.error}` });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) });
  }
});

// Web chat engine (routes are mounted near the top, after requireLogin)
const webchat = createWebChat({
  domain: DOMAIN,
  service: XMPP_SERVICE,
  resolveName: readNicknameFromDisk,
  listUsers,
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(3005, "127.0.0.1", () => {
  console.log("✅ XMPP Admin Dashboard: http://0.0.0.0:3005");

  // Auto-start Message Bot only. AI Bot is intentionally NOT auto-started here:
  // it logs in as the same JID (broadcast@) as chatbot/xmpp_erp_bot.py, and having
  // both online at once causes duplicate replies to every direct message.
  // Use POST /ai-bot/start if this bot is ever needed instead of the Python one.
  startMessageBot().catch(err => {
    console.error("❌ Failed to auto-start Message Bot:", err.message);
  });
});