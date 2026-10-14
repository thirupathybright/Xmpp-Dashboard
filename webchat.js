// WhatsApp-Web style chat for regular XMPP users.
//
// A user signs in on /login ("Sign in as User") with their XMPP username and
// password. The password is verified by really authenticating against Prosody,
// and the dashboard keeps one XMPP connection per signed-in user on the
// server side. History comes from Prosody's MAM archive, live messages are
// pushed to the browser over Server-Sent Events.
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { client, xml } = require("@xmpp/client");

const NS_MAM = "urn:xmpp:mam:2";
const NS_RSM = "http://jabber.org/protocol/rsm";
const NS_FWD = "urn:xmpp:forward:0";
const NS_CARBONS = "urn:xmpp:carbons:2";
const NS_OOB = "jabber:x:oob";
const NS_DELAY = "urn:xmpp:delay";
const NS_CSI = "urn:xmpp:csi:0";
const NS_UPLOAD = "urn:xmpp:http:upload:0";
const NS_ROSTER = "jabber:iq:roster";
const NS_PUBSUB = "http://jabber.org/protocol/pubsub";
const NS_BOOKMARKS = "urn:xmpp:bookmarks:1";
const NS_MUC = "http://jabber.org/protocol/muc";
const NS_MUC_USER = "http://jabber.org/protocol/muc#user";

const IDLE_DISCONNECT_MS = 10 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const rid = () => crypto.randomBytes(8).toString("hex");
const bare = (jid) => (jid ? String(jid).split("/")[0].toLowerCase() : "");

function createWebChat({ domain, service, resolveName, listUsers }) {
  const mucDomain = `conference.${domain}`;
  const entries = new Map(); // username -> connection state (kept in memory only)
  const failedLogins = new Map(); // ip -> [timestamps]
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  const userPart = (jid) => bare(jid).split("@")[0];
  const nameFor = (jid, rosterNames) => {
    const b = bare(jid);
    const [local, dom] = b.split("@");
    if (dom === domain) {
      let n = "";
      try { n = resolveName(local); } catch (_) {}
      if (n) return n;
    }
    return (rosterNames && rosterNames.get(b)) || local || b;
  };

  // ---------- connection management ----------
  function emit(entry, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of entry.sse) res.write(payload);
  }

  function sendCsi(entry, active) {
    if (!entry.xmpp || entry.status !== "online") return;
    entry.xmpp.send(xml(active ? "active" : "inactive", { xmlns: NS_CSI })).catch(() => {});
  }

  function parseMessage(entry, m, fallbackTs) {
    if (!m || !m.is("message")) return null;
    const me = `${entry.username}@${domain}`;
    const type = m.attrs.type;
    if (type && type !== "chat" && type !== "normal" && type !== "groupchat") return null;
    const body = m.getChildText("body");
    if (!body) return null;
    const oob = m.getChild("x", NS_OOB);
    const delay = m.getChild("delay", NS_DELAY);
    const ts = delay ? Date.parse(delay.attrs.stamp) || fallbackTs : fallbackTs;
    const base = { id: m.attrs.id || rid(), body, oob: oob ? oob.getChildText("url") || null : null, ts };

    if (type === "groupchat") {
      const room = bare(m.attrs.from);
      const sender = String(m.attrs.from || "").split("/").slice(1).join("/");
      if (!sender) return null; // room-level message (subject, notices)
      const mine = new Set([entry.username.toLowerCase(), (entry.nicks[room] || "").toLowerCase()]);
      const fromMe = mine.has(sender.toLowerCase());
      let senderName = sender;
      if (/^[a-z0-9._-]+$/i.test(sender)) senderName = nameFor(`${sender.toLowerCase()}@${domain}`);
      return { ...base, peer: room, group: true, sender: senderName, fromMe };
    }

    const from = bare(m.attrs.from) || me;
    const to = bare(m.attrs.to) || me;
    const fromMe = from === me;
    return { ...base, peer: fromMe ? to : from, fromMe };
  }

  function handleStanza(entry, s) {
    if (s.is("presence")) {
      // Our own presence reflected by a room tells us which nick we hold there.
      const room = bare(s.attrs.from);
      const x = s.getChild("x", NS_MUC_USER);
      if (room.endsWith(`@${mucDomain}`) && x && x.getChildren("status").some((st) => st.attrs.code === "110")) {
        entry.nicks[room] = String(s.attrs.from).split("/").slice(1).join("/");
      }
      return;
    }
    if (!s.is("message")) return;
    const me = `${entry.username}@${domain}`;

    // Carbon copy of something another of the user's clients sent/received.
    const carbon = s.getChild("sent", NS_CARBONS) || s.getChild("received", NS_CARBONS);
    if (carbon) {
      if (bare(s.attrs.from) !== me) return; // carbons must come from our own account
      const inner = carbon.getChild("forwarded", NS_FWD)?.getChild("message");
      const msg = parseMessage(entry, inner, Date.now());
      if (msg) emit(entry, "message", msg);
      return;
    }
    if (s.getChild("result", NS_MAM)) return; // archive replay, handled by mamPage()

    const from = bare(s.attrs.from);
    if (s.getChild("composing", "http://jabber.org/protocol/chatstates")) {
      emit(entry, "typing", { peer: from, typing: true });
    } else if (s.getChild("paused", "http://jabber.org/protocol/chatstates") ||
               s.getChild("active", "http://jabber.org/protocol/chatstates")) {
      emit(entry, "typing", { peer: from, typing: false });
    }
    const msg = parseMessage(entry, s, Date.now());
    if (msg) emit(entry, "message", msg);
  }

  function openConnection(entry) {
    if (entry.xmpp && entry.ready) return entry.ready;

    const xmpp = client({
      service,
      domain,
      username: entry.username,
      password: entry.password,
      resource: `webchat-${rid().slice(0, 6)}`,
    });
    entry.xmpp = xmpp;
    entry.status = "connecting";

    entry.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        entry.status = "offline";
        entry.xmpp = null;
        entry.ready = null;
        xmpp.stop().catch(() => {});
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("timeout")), 15000);

      xmpp.on("stanza", (s) => handleStanza(entry, s));
      xmpp.on("offline", () => { entry.status = "offline"; });
      xmpp.on("error", (err) => {
        if (!settled) return fail(err);
        console.error(`[webchat] ${entry.username} xmpp error:`, err?.message || err);
      });
      xmpp.on("online", async () => {
        entry.status = "online";
        try {
          // Negative priority: the web session never steals normal message
          // routing from the user's phone; it still receives carbon copies.
          await xmpp.send(xml("presence", {}, xml("priority", {}, "-1")));
          await xmpp.iqCaller
            .request(xml("iq", { type: "set" }, xml("enable", { xmlns: NS_CARBONS })), 10000)
            .catch(() => {});
          sendCsi(entry, entry.sse.size > 0);
          joinRooms(entry);
        } catch (_) {}
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      });
      xmpp.start().catch(fail);
    });
    return entry.ready;
  }

  function touch(entry) { entry.lastActive = Date.now(); }

  async function ensure(entry) {
    touch(entry);
    if (entry.xmpp && entry.status === "online") return;
    await openConnection(entry);
  }

  // Close connections nobody is looking at, so the phone's push notifications
  // are never held back by a forgotten browser tab.
  setInterval(() => {
    const now = Date.now();
    for (const entry of entries.values()) {
      if (entry.xmpp && entry.sse.size === 0 && now - entry.lastActive > IDLE_DISCONNECT_MS) {
        entry.xmpp.stop().catch(() => {});
        entry.xmpp = null;
        entry.ready = null;
        entry.status = "offline";
      }
    }
  }, 60 * 1000).unref();

  // ---------- login / logout ----------
  function tooManyFails(ip) {
    const now = Date.now();
    const list = (failedLogins.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failedLogins.set(ip, list);
    return list.length >= LOGIN_MAX_FAILS;
  }

  async function login(rawUsername, password, ip) {
    if (tooManyFails(ip)) {
      throw Object.assign(new Error("Too many failed attempts. Try again in a few minutes."), { status: 429 });
    }
    let username = String(rawUsername || "").trim().toLowerCase();
    if (username.endsWith(`@${domain}`)) username = username.slice(0, -(domain.length + 1));
    if (!/^[a-z0-9._-]+$/.test(username) || !password) {
      failedLogins.get(ip).push(Date.now());
      throw Object.assign(new Error("Invalid username or password."), { status: 401 });
    }

    // Always authenticate with a fresh connection so a wrong password can
    // never ride on an existing session of the same user.
    const probe = { username, password, nicks: {}, rooms: [], sse: new Set(), xmpp: null, ready: null, status: "offline", lastActive: Date.now() };
    try {
      await openConnection(probe);
    } catch (err) {
      const cond = err && (err.condition || err.name || "");
      if (/not-authorized|SASLError/i.test(String(cond)) || /not-authorized/i.test(String(err?.message))) {
        failedLogins.get(ip).push(Date.now());
        throw Object.assign(new Error("Invalid username or password."), { status: 401 });
      }
      console.error(`[webchat] login connect failed for ${username}:`, err?.message || err);
      throw Object.assign(new Error("Could not reach the chat server. Please try again."), { status: 503 });
    }

    const old = entries.get(username);
    if (old) {
      // Keep open event streams of existing tabs; swap in the verified connection.
      probe.sse = old.sse;
      if (old.xmpp) old.xmpp.stop().catch(() => {});
    }
    entries.set(username, probe);
    return username;
  }

  function logout(username) {
    const entry = entries.get(username);
    if (!entry) return;
    for (const res of entry.sse) { try { res.end(); } catch (_) {} }
    entry.sse.clear();
    if (entry.xmpp) entry.xmpp.stop().catch(() => {});
    entries.delete(username);
  }

  // ---------- archive (MAM) ----------
  async function mamPage(entry, { withJid, room, before, max = 50 }) {
    await ensure(entry);
    const queryid = rid();
    const messages = [];
    const onStanza = (s) => {
      if (!s.is("message")) return;
      const r = s.getChild("result", NS_MAM);
      if (!r || r.attrs.queryid !== queryid) return;
      const f = r.getChild("forwarded", NS_FWD);
      if (!f) return;
      const d = f.getChild("delay", NS_DELAY);
      const msg = parseMessage(entry, f.getChild("message"), d ? Date.parse(d.attrs.stamp) : Date.now());
      if (msg) { msg.archiveId = r.attrs.id; messages.push(msg); }
    };
    entry.xmpp.on("stanza", onStanza);
    try {
      const fields = [xml("field", { var: "FORM_TYPE", type: "hidden" }, xml("value", {}, NS_MAM))];
      if (withJid) fields.push(xml("field", { var: "with" }, xml("value", {}, withJid)));
      const query = xml(
        "query",
        { xmlns: NS_MAM, queryid },
        xml("x", { xmlns: "jabber:x:data", type: "submit" }, ...fields),
        xml("set", { xmlns: NS_RSM }, xml("max", {}, String(max)), before ? xml("before", {}, before) : xml("before"))
      );
      const res = await entry.xmpp.iqCaller.request(xml("iq", room ? { type: "set", to: room } : { type: "set" }, query), 30000);
      const fin = res.getChild("fin", NS_MAM);
      const set = fin && fin.getChild("set", NS_RSM);
      return {
        messages,
        first: set ? set.getChildText("first") : null,
        complete: !fin || fin.attrs.complete === "true",
      };
    } finally {
      entry.xmpp.removeListener("stanza", onStanza);
    }
  }

  async function getRoster(entry) {
    await ensure(entry);
    const res = await entry.xmpp.iqCaller.request(
      xml("iq", { type: "get" }, xml("query", { xmlns: NS_ROSTER })),
      15000
    );
    const names = new Map();
    const query = res.getChild("query", NS_ROSTER);
    for (const item of query ? query.getChildren("item") : []) {
      const jid = bare(item.attrs.jid);
      if (item.attrs.subscription === "remove") continue;
      names.set(jid, item.attrs.name || "");
    }
    return names;
  }

  // Groups the user has joined = their bookmarks (the mobile app and the
  // dashboard both store joined rooms there).
  async function getBookmarks(entry) {
    await ensure(entry);
    const res = await entry.xmpp.iqCaller.request(
      xml("iq", { type: "get" }, xml("pubsub", { xmlns: NS_PUBSUB }, xml("items", { node: NS_BOOKMARKS }))),
      15000
    );
    const items = res.getChild("pubsub", NS_PUBSUB)?.getChild("items");
    const rooms = [];
    for (const item of items ? items.getChildren("item") : []) {
      const jid = bare(item.attrs.id);
      if (!jid.endsWith(`@${mucDomain}`)) continue;
      const conf = item.getChild("conference", NS_BOOKMARKS);
      rooms.push({
        jid,
        name: (conf && conf.attrs.name) || jid.split("@")[0],
        nick: (conf && conf.getChildText("nick")) || "",
      });
    }
    return rooms;
  }

  // Join each room so live group messages are delivered to this session.
  async function joinRooms(entry) {
    try {
      entry.rooms = await getBookmarks(entry);
    } catch (e) {
      console.error(`[webchat] ${entry.username} bookmarks failed:`, e?.message || e);
      return;
    }
    for (const r of entry.rooms) {
      const nick = r.nick || entry.username;
      entry.xmpp
        .send(xml("presence", { to: `${r.jid}/${nick}` }, xml("x", { xmlns: NS_MUC }, xml("history", { maxstanzas: "0" }))))
        .catch(() => {});
    }
  }

  async function getConversations(entry) {
    const me = `${entry.username}@${domain}`;
    const convs = new Map();
    let before;
    for (let page = 0; page < 8; page++) {
      const p = await mamPage(entry, { before, max: 50 });
      for (const m of p.messages.slice().reverse()) {
        if (m.peer === me || convs.has(m.peer)) continue;
        convs.set(m.peer, { peer: m.peer, lastBody: m.body, lastTs: m.ts, lastFromMe: m.fromMe, lastOob: !!m.oob });
      }
      if (p.complete || !p.first) break;
      before = p.first;
    }
    let roster = new Map();
    try { roster = await getRoster(entry); } catch (_) {}

    let groups = [];
    try { groups = entry.rooms = await getBookmarks(entry); } catch (_) {}
    const groupConvs = await Promise.all(groups.map(async (g) => {
      let last = null;
      try { last = (await mamPage(entry, { room: g.jid, max: 15 })).messages.pop(); } catch (_) {}
      return {
        peer: g.jid, name: g.name, group: true,
        lastBody: last ? `${last.fromMe ? "" : last.sender + ": "}${last.body}` : "",
        lastTs: last ? last.ts : 0, lastFromMe: !!(last && last.fromMe), lastOob: !!(last && last.oob),
      };
    }));
    for (const jid of roster.keys()) {
      if (jid !== me && !convs.has(jid)) convs.set(jid, { peer: jid, lastBody: "", lastTs: 0, lastFromMe: false });
    }
    return [...convs.values()]
      .map((c) => ({ ...c, name: nameFor(c.peer, roster) }))
      .concat(groupConvs)
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  // ---------- helpers ----------
  function normalizePeer(to) {
    let jid = String(to || "").trim().toLowerCase();
    if (!jid) return null;
    if (!jid.includes("@")) jid = `${jid}@${domain}`;
    const esc = (d) => d.replace(/\./g, "\\.");
    return new RegExp(`^[a-z0-9._-]+@(${esc(domain)}|${esc(mucDomain)})$`).test(jid) ? jid : null;
  }

  async function requestUploadSlot(entry, filename, size, contentType) {
    const res = await entry.xmpp.iqCaller.request(
      xml("iq", { type: "get", to: domain },
        xml("request", { xmlns: NS_UPLOAD, filename, size: String(size), "content-type": contentType })),
      15000
    );
    const slot = res.getChild("slot", NS_UPLOAD);
    const put = slot && slot.getChild("put");
    const get = slot && slot.getChild("get");
    if (!put || !get) throw new Error("Upload service returned no slot");
    const headers = {};
    for (const h of put.getChildren("header")) {
      if (/^(authorization|cookie|expires)$/i.test(h.attrs.name)) headers[h.attrs.name] = h.text();
    }
    return { putUrl: put.attrs.url, getUrl: get.attrs.url, headers };
  }

  // ---------- HTTP routes ----------
  const router = express.Router();

  const needUser = (req, res, next) => {
    const entry = req.session && req.session.role === "user" && entries.get(req.session.xmppUser);
    if (!entry) return res.status(401).json({ success: false, error: "Session expired. Please sign in again." });
    req.chat = entry;
    touch(entry);
    next();
  };
  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      console.error("[webchat]", req.path, e?.message || e);
      res.status(500).json({ success: false, error: e?.message || "Request failed" });
    });

  router.get("/me", needUser, (req, res) => {
    const jid = `${req.chat.username}@${domain}`;
    res.json({ success: true, jid, username: req.chat.username, name: nameFor(jid) });
  });

  router.get("/conversations", needUser, wrap(async (req, res) => {
    res.json({ success: true, conversations: await getConversations(req.chat) });
  }));

  router.get("/messages", needUser, wrap(async (req, res) => {
    const peer = normalizePeer(req.query.peer);
    if (!peer) return res.status(400).json({ success: false, error: "Invalid contact" });
    const before = req.query.before ? String(req.query.before) : undefined;
    const isRoom = peer.endsWith(`@${mucDomain}`);
    const p = await mamPage(req.chat, isRoom ? { room: peer, before, max: 40 } : { withJid: peer, before, max: 40 });
    res.json({ success: true, messages: p.messages, first: p.first, complete: p.complete });
  }));

  router.get("/search", needUser, (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 1) return res.json({ success: true, users: [] });
    const me = req.chat.username;
    const users = listUsers()
      .filter((u) => u !== me)
      .map((u) => ({ jid: `${u}@${domain}`, username: u, name: nameFor(`${u}@${domain}`) }))
      .filter((u) => u.username.includes(q) || u.name.toLowerCase().includes(q))
      .slice(0, 30);
    res.json({ success: true, users });
  });

  router.post("/send", needUser, wrap(async (req, res) => {
    const peer = normalizePeer(req.body && req.body.to);
    const body = String((req.body && req.body.body) || "").trim();
    if (!peer || !body || body.length > 4000) {
      return res.status(400).json({ success: false, error: "Invalid message" });
    }
    await ensure(req.chat);
    const id = rid();
    if (peer.endsWith(`@${mucDomain}`)) {
      // The room reflects the message back to us; that reflection (via SSE)
      // is what shows up in the chat, so nothing is emitted locally.
      if (!req.chat.rooms.some((r) => r.jid === peer)) {
        return res.status(403).json({ success: false, error: "You have not joined this group" });
      }
      await req.chat.xmpp.send(xml("message", { type: "groupchat", to: peer, id }, xml("body", {}, body)));
      return res.json({ success: true, message: { id, peer, group: true, fromMe: true, body, oob: null, ts: Date.now() } });
    }
    await req.chat.xmpp.send(xml("message", { type: "chat", to: peer, id }, xml("body", {}, body)));
    const msg = { id, peer, fromMe: true, body, oob: null, ts: Date.now() };
    emit(req.chat, "message", msg);
    res.json({ success: true, message: msg });
  }));

  router.post("/upload", needUser, upload.single("file"), wrap(async (req, res) => {
    const peer = normalizePeer(req.body && req.body.to);
    if (!peer || !req.file) return res.status(400).json({ success: false, error: "Invalid upload" });
    await ensure(req.chat);
    const f = req.file;
    const filename = (f.originalname || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "file";
    const contentType = f.mimetype || "application/octet-stream";
    const slot = await requestUploadSlot(req.chat, filename, f.size, contentType);
    const put = await fetch(slot.putUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType, ...slot.headers },
      body: f.buffer,
    });
    if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
    const id = rid();
    const isRoom = peer.endsWith(`@${mucDomain}`);
    if (isRoom && !req.chat.rooms.some((r) => r.jid === peer)) {
      return res.status(403).json({ success: false, error: "You have not joined this group" });
    }
    await req.chat.xmpp.send(
      xml("message", { type: isRoom ? "groupchat" : "chat", to: peer, id },
        xml("body", {}, slot.getUrl),
        xml("x", { xmlns: NS_OOB }, xml("url", {}, slot.getUrl)))
    );
    const msg = { id, peer, fromMe: true, body: slot.getUrl, oob: slot.getUrl, ts: Date.now(), ...(isRoom ? { group: true } : {}) };
    if (!isRoom) emit(req.chat, "message", msg);
    res.json({ success: true, message: msg });
  }));

  router.get("/events", needUser, (req, res) => {
    const entry = req.chat;
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    entry.sse.add(res);
    ensure(entry).then(() => { sendCsi(entry, true); res.write("event: ready\ndata: {}\n\n"); }).catch(() => {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Cannot reach chat server" })}\n\n`);
    });
    const hb = setInterval(() => { touch(entry); res.write(": hb\n\n"); }, 25000);
    req.on("close", () => {
      clearInterval(hb);
      entry.sse.delete(res);
      if (entry.sse.size === 0) sendCsi(entry, false);
    });
  });

  return { router, login, logout };
}

module.exports = createWebChat;
