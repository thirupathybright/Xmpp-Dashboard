// Reads real data directly from Prosody's on-disk storage to build
// dashboard analytics: user counts, message activity, uploads, group chats.
const fs = require("fs");
const path = require("path");

const PROSODY_ROOT = "/var/lib/prosody";
const VHOST_DIR = path.join(PROSODY_ROOT, "chat%2ethirupathybright%2ein");
const MUC_DIR = path.join(PROSODY_ROOT, "conference%2echat%2ethirupathybright%2ein");

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function countAccounts() {
  return safeReaddir(path.join(VHOST_DIR, "accounts")).filter((f) => f.endsWith(".dat")).length;
}

function accountRecentActivity(days = 7) {
  // Uses account.dat mtime as a rough proxy for "recently active" (login/password change/etc touch it)
  const dir = path.join(VHOST_DIR, "accounts");
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let recent = 0;
  for (const f of safeReaddir(dir)) {
    if (!f.endsWith(".dat")) continue;
    const st = safeStat(path.join(dir, f));
    if (st && st.mtimeMs >= cutoff) recent++;
  }
  return recent;
}

function messageArchiveStats() {
  const dir = path.join(VHOST_DIR, "archive");
  const files = safeReaddir(dir).filter((f) => f.endsWith(".list"));
  let totalApproxMessages = 0;
  let mostActive = null;
  let mostActiveCount = 0;

  for (const f of files) {
    const full = path.join(dir, f);
    const st = safeStat(full);
    if (!st) continue;
    // Each stored item spans ~11 lines in the Lua serialization; use line count / 11 as a rough message estimate
    let lines = 0;
    try {
      lines = fs.readFileSync(full, "utf8").split("\n").length;
    } catch (_) {
      continue;
    }
    const approxMsgs = Math.max(0, Math.round(lines / 11));
    totalApproxMessages += approxMsgs;
    if (approxMsgs > mostActiveCount) {
      mostActiveCount = approxMsgs;
      mostActive = f.replace(/\.list$/, "");
    }
  }

  return {
    usersWithHistory: files.length,
    totalApproxMessages,
    mostActiveUser: mostActive,
    mostActiveUserApproxMessages: mostActiveCount,
  };
}

function uploadStats() {
  const dir = path.join(VHOST_DIR, "http_upload");
  const slots = safeReaddir(dir);
  let totalFiles = 0;
  let totalBytes = 0;
  for (const slot of slots) {
    const slotPath = path.join(dir, slot);
    const st = safeStat(slotPath);
    if (!st || !st.isDirectory()) continue;
    for (const f of safeReaddir(slotPath)) {
      const fst = safeStat(path.join(slotPath, f));
      if (fst) {
        totalFiles++;
        totalBytes += fst.size;
      }
    }
  }
  return { totalFiles, totalBytes };
}

function groupChatStats() {
  const logDir = path.join(MUC_DIR, "muc_log");
  const rooms = safeReaddir(logDir).length;
  return { totalRooms: rooms };
}

function offlineMessageStats() {
  const dir = path.join(VHOST_DIR, "offline");
  return { usersWithPendingMessages: safeReaddir(dir).length };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

module.exports = {
  countAccounts,
  accountRecentActivity,
  messageArchiveStats,
  uploadStats,
  groupChatStats,
  offlineMessageStats,
  formatBytes,
  getDashboardStats: function () {
    const totalAccounts = countAccounts();
    const recentlyActive7d = accountRecentActivity(7);
    const messages = messageArchiveStats();
    const uploads = uploadStats();
    const groups = groupChatStats();
    const offline = offlineMessageStats();

    return {
      totalAccounts,
      recentlyActive7d,
      messages,
      uploads: { ...uploads, totalBytesFormatted: formatBytes(uploads.totalBytes) },
      groups,
      offline,
    };
  },
};
