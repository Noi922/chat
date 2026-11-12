'use strict';
// Chat-Server: HTTP (Web-Client, Uploads, Healthcheck) + WebSocket (Echtzeit)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PAGE = 50; // Nachrichten pro Verlaufsseite
const DEFAULT_ROOM = 'lobby';
const NAME_RE = /^[\p{L}\p{N}_.-]{2,20}$/u;
const ROOM_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const UPLOAD_RE = /^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/;
const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[^\s\w<>&"']{0,15}$/u;
const MAX_REACTIONS = 12; // verschiedene Emojis pro Nachricht
const PENDING_TTL_MS = 10 * 60 * 1000; // nicht verwendete Uploads werden danach gelöscht

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Bildtyp anhand der ersten Bytes bestimmen (dem Content-Type des Clients wird nicht vertraut)
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function normRoom(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-');
  return ROOM_RE.test(name) ? name : '';
}

function createApp(cfg) {
  const store = new Store(cfg.dataDir);
  const uploadDir = path.join(cfg.dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  const live = new Map(); // Raumname -> Set<ws> (aktuell verbundene Nutzer)
  const ipCount = new Map(); // IP -> Anzahl Verbindungen
  const pending = new Map(); // hochgeladene, noch keiner Nachricht zugeordnete Dateien
  const startedAt = Date.now();
  let uploadBytes = 0;

  // Beim Start: Uploads ohne zugehörige Nachricht entfernen, Speicherverbrauch zählen
  {
    const used = new Set();
    for (const room of store.rooms.values()) {
      for (const m of room.messages) if (m.image) used.add(path.basename(m.image));
    }
    for (const file of fs.readdirSync(uploadDir)) {
      const full = path.join(uploadDir, file);
      try {
        if (used.has(file)) uploadBytes += fs.statSync(full).size;
        else fs.unlinkSync(full);
      } catch {
        /* Datei nicht lesbar – ignorieren */
      }
    }
  }

  // ---------- Hilfsfunktionen ----------
  const send = (ws, payload) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  };
  const fail = (ws, text) => send(ws, { type: 'error', text });
  const system = (text) => ({ type: 'system', text, ts: Date.now() });

  function broadcast(roomName, payload, except) {
    const set = live.get(roomName);
    if (!set) return;
    const data = JSON.stringify(payload);
    for (const client of set) if (client !== except && client.readyState === 1) client.send(data);
  }

  // Einfache Ratenbegrenzung pro Verbindung und Aktion
  function allow(ws, key, limit, windowMs) {
    const now = Date.now();
    const stamps = (ws.user.rate[key] || []).filter((t) => now - t < windowMs);
    ws.user.rate[key] = stamps;
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  }

  const publicMessage = (m) => m; // Nachrichten enthalten keine geheimen Felder

  function userList(roomName) {
    const set = live.get(roomName);
    if (!set) return [];
    return [...set]
      .map((c) => ({ name: c.user.name, admin: c.user.admin }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  function roomList() {
    const names = new Set([DEFAULT_ROOM, ...store.rooms.keys(), ...live.keys()]);
    return [...names]
      .map((name) => ({ name, count: live.has(name) ? live.get(name).size : 0 }))
      .sort((a, b) => (b.name === DEFAULT_ROOM) - (a.name === DEFAULT_ROOM) || a.name.localeCompare(b.name, 'de'));
  }

  function broadcastRooms() {
    const data = JSON.stringify({ type: 'rooms', rooms: roomList() });
    for (const client of wss.clients) if (client.user && client.user.room && client.readyState === 1) client.send(data);
  }

  function findByName(name) {
    const lower = name.toLowerCase();
    for (const client of wss.clients) {
      if (client.user && client.user.name && client.user.name.toLowerCase() === lower) return client;
    }
    return null;
  }

  function removeUpload(message) {
    if (!message.image) return;
    const full = path.join(uploadDir, path.basename(message.image));
    fs.stat(full, (err, stat) => {
      if (err) return;
      fs.unlink(full, (unlinkErr) => {
        if (!unlinkErr) uploadBytes = Math.max(0, uploadBytes - stat.size);
      });
    });
  }

  function leaveRoom(ws, { silent = false } = {}) {
    const { name, room: roomName } = ws.user;
    if (!roomName) return;
    ws.user.room = null;
    const set = live.get(roomName);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      live.delete(roomName);
      return;
    }
    if (!silent) broadcast(roomName, system(`${name} hat den Raum verlassen`));
    broadcast(roomName, { type: 'users', users: userList(roomName) });
  }

  function sendJoined(ws) {
    const room = store.rooms.get(ws.user.room);
    const messages = room ? room.messages : [];
    send(ws, {
      type: 'joined',
      name: ws.user.name,
      room: ws.user.room,
      token: ws.user.token,
      uid: ws.user.uid,
      admin: ws.user.admin,
      topic: room ? room.topic : '',
      history: messages.slice(-PAGE).map(publicMessage),
      hasMore: messages.length > PAGE,
      users: userList(ws.user.room),
      rooms: roomList(),
    });
  }

  function enterRoom(ws, roomName, { silent = false } = {}) {
    if (ws.user.room === roomName) return sendJoined(ws);
    const exists = roomName === DEFAULT_ROOM || live.has(roomName) || store.rooms.has(roomName);
    if (!exists && roomList().length >= cfg.maxRooms) {
      return fail(ws, 'Es gibt bereits zu viele Räume – bitte einen bestehenden wählen.');
    }
    leaveRoom(ws);
    ws.user.room = roomName;
    if (!live.has(roomName)) live.set(roomName, new Set());
    live.get(roomName).add(ws);
    sendJoined(ws);
    if (!silent) broadcast(roomName, system(`${ws.user.name} ist dem Raum beigetreten`), ws);
    broadcast(roomName, { type: 'users', users: userList(roomName) }, ws);
    broadcastRooms();
  }

  function findMessage(ws, id) {
    const room = store.rooms.get(ws.user.room);
    if (!room || !Number.isInteger(id)) return {};
    return { room, message: room.messages.find((m) => m.id === id) };
  }

  // ---------- Nachrichten-Handler ----------
  const handlers = {
    join(ws, msg) {
      const roomName = normRoom(msg.room) || (msg.room ? '' : DEFAULT_ROOM);
      if (!roomName) return fail(ws, 'Raumnamen dürfen nur Buchstaben, Ziffern, „-" und „_" enthalten (max. 30 Zeichen).');
      let silent = false;
      if (!ws.user.name) {
        const name = typeof msg.name === 'string' ? msg.name.trim() : '';
        if (!NAME_RE.test(name)) {
          return fail(ws, 'Namen brauchen 2–20 Zeichen: Buchstaben, Ziffern, „.", „-" und „_" (keine Leerzeichen).');
        }
        const token = TOKEN_RE.test(msg.token) ? msg.token : crypto.randomBytes(16).toString('hex');
        const existing = findByName(name);
        if (existing && existing !== ws) {
          if (existing.user.token !== token) return fail(ws, `Der Name „${name}" ist bereits vergeben.`);
          // Gleiche Person (gleiches Token) verbindet sich neu: alte Sitzung ersetzen
          silent = existing.user.room === roomName;
          ws.user.admin = existing.user.admin;
          leaveRoom(existing, { silent });
          existing.user.name = null;
          send(existing, { type: 'replaced' });
          existing.close(4000, 'replaced');
        }
        ws.user.name = name;
        ws.user.token = token;
        ws.user.uid = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
      }
      enterRoom(ws, roomName, { silent });
    },

    switch(ws, msg) {
      const roomName = normRoom(msg.room);
      if (!roomName) return fail(ws, 'Raumnamen dürfen nur Buchstaben, Ziffern, „-" und „_" enthalten (max. 30 Zeichen).');
      if (!allow(ws, 'switch', 10, 10000)) return fail(ws, 'Zu viele Raumwechsel – bitte kurz warten.');
      enterRoom(ws, roomName);
    },

    message(ws, msg) {
      if (!allow(ws, 'message', 8, 5000)) return fail(ws, 'Zu viele Nachrichten – bitte kurz warten.');
      const text = cleanText(msg.text, cfg.maxText);
      let image = null;
      if (msg.image != null) {
        const match = UPLOAD_RE.exec(String(msg.image));
        const entry = match && pending.get(match[1]);
        if (!entry || entry.uid !== ws.user.uid) return fail(ws, 'Das Bild ist nicht (mehr) verfügbar.');
        pending.delete(match[1]);
        image = `/uploads/${match[1]}`;
      }
      if (!text && !image) return;

      const room = store.ensureRoom(ws.user.room);
      const message = { id: store.nextId(), uid: ws.user.uid, name: ws.user.name, text, ts: Date.now() };
      if (msg.action === true && text && !image) message.kind = 'action';
      if (image) message.image = image;
      if (Number.isInteger(msg.replyTo)) {
        const target = room.messages.find((m) => m.id === msg.replyTo);
        if (target) {
          message.replyTo = { id: target.id, name: target.name, text: (target.text || '📷 Bild').slice(0, 140) };
        }
      }
      room.messages.push(message);
      while (room.messages.length > cfg.historySize) removeUpload(room.messages.shift());
      store.save();
      broadcast(ws.user.room, { type: 'message', message: publicMessage(message) });
    },

    edit(ws, msg) {
      const { message } = findMessage(ws, msg.id);
      if (!message) return fail(ws, 'Nachricht nicht gefunden.');
      if (message.uid !== ws.user.uid) return fail(ws, 'Du kannst nur eigene Nachrichten bearbeiten.');
      const text = cleanText(msg.text, cfg.maxText);
      if (!text) return fail(ws, 'Die Nachricht darf nicht leer sein.');
      if (text === message.text) return;
      message.text = text;
      message.editedAt = Date.now();
      store.save();
      broadcast(ws.user.room, { type: 'edited', id: message.id, text, editedAt: message.editedAt });
    },

    delete(ws, msg) {
      const { room, message } = findMessage(ws, msg.id);
      if (!message) return fail(ws, 'Nachricht nicht gefunden.');
      if (message.uid !== ws.user.uid && !ws.user.admin) return fail(ws, 'Du kannst nur eigene Nachrichten löschen.');
      room.messages.splice(room.messages.indexOf(message), 1);
      removeUpload(message);
      store.save();
      broadcast(ws.user.room, { type: 'deleted', id: message.id });
    },

    react(ws, msg) {
      if (!allow(ws, 'react', 20, 10000)) return;
      const { message } = findMessage(ws, msg.id);
      if (!message) return;
      const emoji = typeof msg.emoji === 'string' ? msg.emoji : '';
      if (!EMOJI_RE.test(emoji)) return fail(ws, 'Ungültiges Emoji.');
      const reactions = new Map(Object.entries(message.reactions || {}));
      const names = reactions.get(emoji) || [];
      const index = names.indexOf(ws.user.name);
      if (index >= 0) names.splice(index, 1);
      else if (!reactions.has(emoji) && reactions.size >= MAX_REACTIONS) return fail(ws, 'Zu viele verschiedene Reaktionen.');
      else names.push(ws.user.name);
      if (names.length) reactions.set(emoji, names);
      else reactions.delete(emoji);
      if (reactions.size) message.reactions = Object.fromEntries(reactions);
      else delete message.reactions;
      store.save();
      broadcast(ws.user.room, { type: 'reactions', id: message.id, reactions: message.reactions || {} });
    },

    typing(ws) {
      if (!allow(ws, 'typing', 6, 5000)) return;
      broadcast(ws.user.room, { type: 'typing', name: ws.user.name }, ws);
    },

    history(ws, msg) {
      if (!allow(ws, 'history', 10, 5000)) return;
      const room = store.rooms.get(ws.user.room);
      const all = room ? room.messages : [];
      const before = Number.isInteger(msg.before) ? msg.before : Infinity;
      let end = all.length;
      while (end > 0 && all[end - 1].id >= before) end--;
      const start = Math.max(0, end - PAGE);
      send(ws, { type: 'history', messages: all.slice(start, end).map(publicMessage), hasMore: start > 0 });
    },

    dm(ws, msg) {
      if (!allow(ws, 'message', 8, 5000)) return fail(ws, 'Zu viele Nachrichten – bitte kurz warten.');
      const text = cleanText(msg.text, cfg.maxText);
      const target = typeof msg.to === 'string' ? findByName(msg.to.trim()) : null;
      if (!target) return fail(ws, 'Diese Person ist gerade nicht online.');
      if (target === ws) return fail(ws, 'Du kannst dir nicht selbst schreiben.');
      if (!text) return;
      const payload = { type: 'dm', from: ws.user.name, to: target.user.name, text, ts: Date.now() };
      send(target, payload);
      send(ws, payload);
    },

    nick(ws, msg) {
      if (!allow(ws, 'nick', 3, 60000)) return fail(ws, 'Du hast deinen Namen zu oft geändert – bitte warte kurz.');
      const name = typeof msg.name === 'string' ? msg.name.trim() : '';
      if (!NAME_RE.test(name)) {
        return fail(ws, 'Namen brauchen 2–20 Zeichen: Buchstaben, Ziffern, „.", „-" und „_" (keine Leerzeichen).');
      }
      const existing = findByName(name);
      if (existing && existing !== ws) return fail(ws, `Der Name „${name}" ist bereits vergeben.`);
      const old = ws.user.name;
      if (old === name) return;
      ws.user.name = name;
      send(ws, { type: 'nick', name });
      broadcast(ws.user.room, system(`${old} heißt jetzt ${name}`));
      broadcast(ws.user.room, { type: 'users', users: userList(ws.user.room) });
    },

    topic(ws, msg) {
      if (!allow(ws, 'topic', 3, 30000)) return fail(ws, 'Das Thema wurde zu oft geändert – bitte warte kurz.');
      const topic = cleanLine(msg.text, 120);
      const room = store.ensureRoom(ws.user.room);
      if (room.topic === topic) return;
      room.topic = topic;
      store.save();
      broadcast(ws.user.room, { type: 'topic', topic });
      broadcast(
        ws.user.room,
        system(topic ? `${ws.user.name} hat das Thema geändert: ${topic}` : `${ws.user.name} hat das Thema entfernt`),
      );
      broadcastRooms();
    },

    admin(ws, msg) {
      if (!cfg.adminPassword) return fail(ws, 'Auf diesem Server ist kein Admin-Passwort eingerichtet.');
      ws.user.adminTries = (ws.user.adminTries || 0) + 1;
      if (ws.user.adminTries > 5) return ws.close(4003, 'too many attempts');
      const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
      if (!crypto.timingSafeEqual(hash(msg.password), hash(cfg.adminPassword))) return fail(ws, 'Falsches Passwort.');
      ws.user.admin = true;
      ws.user.adminTries = 0;
      send(ws, { type: 'admin', admin: true });
      broadcast(ws.user.room, { type: 'users', users: userList(ws.user.room) });
    },

    kick(ws, msg) {
      if (!ws.user.admin) return fail(ws, 'Dafür brauchst du Admin-Rechte (/admin <Passwort>).');
      const target = typeof msg.name === 'string' ? findByName(msg.name.trim()) : null;
      if (!target) return fail(ws, 'Diese Person ist gerade nicht online.');
      if (target === ws) return fail(ws, 'Du kannst dich nicht selbst entfernen.');
      const { name, room } = target.user;
      send(target, { type: 'kicked' });
      leaveRoom(target, { silent: true });
      target.user.name = null;
      target.close(4001, 'kicked');
      broadcast(room, system(`${name} wurde von ${ws.user.name} entfernt`));
      broadcastRooms();
    },

    delroom(ws, msg) {
      if (!ws.user.admin) return fail(ws, 'Dafür brauchst du Admin-Rechte (/admin <Passwort>).');
      const roomName = normRoom(msg.room);
      if (!roomName || !store.rooms.has(roomName)) return fail(ws, 'Diesen Raum gibt es nicht.');
      if (live.has(roomName)) return fail(ws, 'In diesem Raum sind noch Personen online.');
      for (const m of store.rooms.get(roomName).messages) removeUpload(m);
      store.rooms.delete(roomName);
      store.save();
      send(ws, system(`Raum #${roomName} wurde gelöscht`));
      broadcastRooms();
    },
  };

  // ---------- HTTP ----------
  function json(res, status, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  function handleUpload(req, res) {
    if (!cfg.uploads) return json(res, 404, { error: 'Uploads sind deaktiviert.' });
    const token = req.headers['x-chat-token'];
    let owner = null;
    for (const client of wss.clients) {
      if (client.user && client.user.name && client.user.token === token) owner = client;
    }
    if (!owner) return json(res, 401, { error: 'Nicht angemeldet.' });
    if (!allow(owner, 'upload', 5, 60000)) return json(res, 429, { error: 'Zu viele Uploads – bitte kurz warten.' });

    const tooLarge = () => {
      aborted = true;
      const mb = Math.floor(cfg.maxUploadBytes / 1024 / 1024);
      res.on('finish', () => req.destroy());
      json(res, 413, { error: `Das Bild ist zu groß (max. ${mb} MB).` }, { Connection: 'close' });
    };
    let aborted = false;
    let size = 0;
    const chunks = [];
    if (Number(req.headers['content-length']) > cfg.maxUploadBytes) return tooLarge();

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > cfg.maxUploadBytes) return tooLarge();
      chunks.push(chunk);
    });
    req.on('error', () => {
      aborted = true;
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      const ext = sniffImage(buf);
      if (!ext) return json(res, 415, { error: 'Nur Bilder (PNG, JPEG, GIF, WebP) sind erlaubt.' });
      if (uploadBytes + buf.length > cfg.maxUploadDirBytes) {
        return json(res, 507, { error: 'Der Bildspeicher des Servers ist voll.' });
      }
      const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      uploadBytes += buf.length;
      fs.writeFile(path.join(uploadDir, name), buf, (err) => {
        if (err) {
          uploadBytes -= buf.length;
          return json(res, 500, { error: 'Speichern fehlgeschlagen.' });
        }
        pending.set(name, { uid: owner.user.uid, at: Date.now(), size: buf.length });
        json(res, 201, { url: `/uploads/${name}` });
      });
    });
  }

  function serveFile(req, res, file, headers) {
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Nicht gefunden');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        ...headers,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      res.writeHead(400);
      return res.end();
    }

    if (req.method === 'POST' && urlPath === '/upload') return handleUpload(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    if (urlPath === '/healthz') {
      let users = 0;
      for (const set of live.values()) users += set.size;
      return json(res, 200, { status: 'ok', users, rooms: roomList().length, uptime: Math.floor((Date.now() - startedAt) / 1000) });
    }
    if (urlPath === '/api/info') {
      return json(res, 200, {
        name: cfg.serverName,
        uploads: cfg.uploads,
        maxUploadBytes: cfg.maxUploadBytes,
        maxText: cfg.maxText,
      });
    }

    const upload = UPLOAD_RE.exec(urlPath);
    if (upload) {
      return serveFile(req, res, path.join(uploadDir, upload[1]), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }

    const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    serveFile(req, res, file, { 'Cache-Control': 'no-cache' });
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  function clientIp(req) {
    if (cfg.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unbekannt';
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    ws.user = { name: null, room: null, token: null, uid: null, admin: false, rate: {} };
    ws.isAlive = true;
    ws.on('error', () => {});

    const count = (ipCount.get(ip) || 0) + 1;
    if (count > cfg.maxConnectionsPerIp) {
      send(ws, { type: 'error', text: 'Zu viele Verbindungen von deiner Adresse.' });
      return ws.close(1013, 'too many connections');
    }
    ipCount.set(ip, count);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return fail(ws, 'Ungültiges Format.');
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (!Object.prototype.hasOwnProperty.call(handlers, msg.type)) return;
      if (msg.type !== 'join' && !ws.user.room) return fail(ws, 'Du bist in keinem Raum.');
      try {
        handlers[msg.type](ws, msg);
      } catch (err) {
        console.error(`Fehler bei „${msg.type}":`, err);
        fail(ws, 'Interner Fehler.');
      }
    });

    ws.on('close', () => {
      const left = ipCount.get(ip) - 1;
      if (left > 0) ipCount.set(ip, left);
      else ipCount.delete(ip);
      const hadRoom = Boolean(ws.user.room);
      leaveRoom(ws);
      if (hadRoom) broadcastRooms();
    });
  });

  // Tote Verbindungen schließen, verwaiste Uploads aufräumen
  const housekeeping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [name, entry] of pending) {
      if (now - entry.at < PENDING_TTL_MS) continue;
      pending.delete(name);
      fs.unlink(path.join(uploadDir, name), (err) => {
        if (!err) uploadBytes = Math.max(0, uploadBytes - entry.size);
      });
    }
  }, 30000);
  housekeeping.unref();

  return {
    server,
    store,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(housekeeping);
      for (const ws of wss.clients) ws.close(1001, 'server shutdown');
      return new Promise((resolve) => {
        wss.close(() => {
          server.close(() => {
            store.flushSync();
            resolve();
          });
          if (server.closeAllConnections) server.closeAllConnections();
        });
        setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
        }, 1000).unref();
      });
    },
  };
}

module.exports = { createApp };
