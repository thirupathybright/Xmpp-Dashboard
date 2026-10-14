// Simple session-based authentication for the XMPP dashboard.
// Single admin account, credentials hashed on disk (not stored in plaintext).
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");

const CREDENTIALS_FILE = path.join(__dirname, "admin_credentials.json");

function ensureAdminAccount() {
  if (fs.existsSync(CREDENTIALS_FILE)) return;

  const defaultEmail = "tbi@gmail.com";
  const defaultPassword = "admin@123";
  const hash = bcrypt.hashSync(defaultPassword, 10);

  fs.writeFileSync(
    CREDENTIALS_FILE,
    JSON.stringify({ email: defaultEmail, passwordHash: hash }, null, 2),
    "utf8"
  );
  console.log(`[auth] Created default admin account: ${defaultEmail}`);
}

function loadAdminAccount() {
  return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
}

function verifyLogin(email, password) {
  const account = loadAdminAccount();
  if (!email || !password) return false;
  if (email.trim().toLowerCase() !== account.email.trim().toLowerCase()) return false;
  return bcrypt.compareSync(password, account.passwordHash);
}

// Server-to-server auth: Django (Home/utils.py, Database/xmppmessage.py) calls
// these specific endpoints directly, not through a logged-in browser session.
// They accept a shared secret via the X-API-Key header as an alternative to
// a session login. Keep this list to exactly the routes Django actually uses.
const SERVER_API_KEY = process.env.DASHBOARD_API_KEY || "";
const SERVER_TO_SERVER_PATHS = ["/send-message", "/send-image", "/ai-bot/status", "/users/list"];

function hasValidApiKey(req) {
  if (!SERVER_API_KEY) return false;
  const provided = req.get("X-API-Key");
  return !!provided && provided === SERVER_API_KEY;
}

// Express middleware: require an authenticated session for everything
// except the login page, the health check, and the server-to-server API
// endpoints (which use the API key instead).
function requireLogin(req, res, next) {
  const openPaths = ["/login", "/health"];
  if (openPaths.includes(req.path)) return next();

  if (SERVER_TO_SERVER_PATHS.includes(req.path) && hasValidApiKey(req)) {
    return next();
  }

  if (req.session && req.session.authenticated) {
    // Admin sessions get the whole dashboard. Chat-user sessions (signed in
    // with their XMPP account) may only reach the web chat and its API.
    if (req.session.role === "admin") return next();
    if (req.session.role === "user") {
      if (req.path === "/chat" || req.path.startsWith("/api/chat/")) return next();
      if (req.path.startsWith("/api/")) {
        return res.status(403).json({ success: false, error: "Forbidden" });
      }
      return res.redirect("/chat");
    }
  }

  if (req.path.startsWith("/api") || req.get("accept") === "application/json") {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }

  return res.redirect("/login");
}

module.exports = { ensureAdminAccount, verifyLogin, requireLogin };
