const express = require("express");
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

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Add JSON body parser for API endpoints
app.set("view engine", "ejs");

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

function runProsodyctlWithPassword(command, jid, newPassword) {
  // prosodyctl adduser/passwd reads password from stdin (twice)
  // We'll pipe "pass\npass\n" using /bin/sh -lc to keep it simple.
  const shCmd = `printf '%s\n%s\n' '${newPassword.replace(
    /'/g,
    "'\\''"
  )}' '${newPassword.replace(/'/g, "'\\''")}' | sudo -n prosodyctl ${command} '${jid.replace(
    /'/g,
    "'\\''"
  )}'`;

  // execFileSync("sh", ["-lc", shCmd]) gives us stdout/stderr
  return execFileSync("sh", ["-lc", shCmd], { encoding: "utf8" });
}

function runProsodyctl(command, jid) {
  // sudo -n => no password prompt (will fail if sudoers not set)
  return execFileSync("sudo", ["-n", "prosodyctl", command, jid], {
    encoding: "utf8",
  });
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

// Send image with caption to specific user
async function sendImageWithCaption(toJid, imageUrl, imageSize, caption = "") {
  try {
    if (!messageBot) {
      throw new Error("Message Bot is not running. Please start the bot first.");
    }

    console.log(`📤 [MESSAGE BOT] Sending image with caption to ${toJid}`);
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

    // Send single message with body and OOB
    // OOB always contains just the download URL
    const message = xml(
      "message",
      { type: "chat", to: toJid },
      xml("body", {}, messageBody),
      xml("x", { xmlns: "jabber:x:oob" }, xml("url", {}, imageUrl))
    );

    await messageBot.send(message);

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

          // Send AI response back to user
          await aiBot.send(
            xml(
              "message",
              { type: "chat", to: senderJid },
              xml("body", {}, plainResponse)
            )
          );

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

// ---- routes ----
app.get("/", (req, res) => {
  try {
    const users = listUsers();
    res.render("index", { users, DOMAIN, msg: null, err: null });
  } catch (e) {
    res.render("index", {
      users: [],
      DOMAIN,
      msg: null,
      err:
        "Cannot read Prosody accounts dir. Fix permissions or path.\n\n" +
        (e?.message || String(e)),
    });
  }
});

app.post("/users/add", (req, res) => {
  try {
    const user = safeUsername(req.body.username);
    const pass = (req.body.password || "").trim();
    if (!user) throw new Error("Invalid username. Use letters/numbers/._- only.");
    if (!pass) throw new Error("Password cannot be empty.");

    const jid = `${user}@${DOMAIN}`;
    // Create user (non-interactive)
    runProsodyctlWithPassword("adduser", jid, pass);

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
    const { to, caption } = req.body;
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
    const sendResult = await sendImageWithCaption(to, uploadResult.url, uploadResult.size, caption || "");

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
 * Send message to a specific user via XMPP
 * POST /send-message
 * Body: { "to": "7550300724@chat.thirupathybright.in", "message": "Hello!" }
 */
app.post("/send-message", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Both 'to' and 'message' are required"
      });
    }

    // Validate JID format (should contain @)
    if (!to.includes("@")) {
      return res.status(400).json({
        success: false,
        error: "Invalid JID format. Expected format: username@domain"
      });
    }

    // Check if message bot is running
    if (!messageBot) {
      return res.status(503).json({
        success: false,
        error: "Message bot is not running. Please start the bot first."
      });
    }

    // Send message
    const result = await sendMessageToUser(to, message);

    if (result.success) {
      res.json({
        success: true,
        message: `Message sent to ${to}`
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || "Failed to send message"
      });
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

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(3005, () => {
  console.log("✅ XMPP Admin Dashboard: http://0.0.0.0:3005");

  // Auto-start both bots on server start
  Promise.all([
    startAIBot().catch(err => {
      console.error("❌ Failed to auto-start AI Bot:", err.message);
    }),
    startMessageBot().catch(err => {
      console.error("❌ Failed to auto-start Message Bot:", err.message);
    })
  ]).then(() => {
    console.log("🚀 All bots initialization completed");
  });
});