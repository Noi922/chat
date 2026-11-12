'use strict';
// Konfiguration ausschließlich über Umgebungsvariablen (siehe .env.example)
const path = require('path');

function int(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

function bool(name, def) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on', 'ja'].includes(raw);
}

function loadConfig(overrides = {}) {
  return {
    port: int('PORT', 3000),
    host: process.env.HOST || undefined, // undefined = alle Schnittstellen (IPv4 + IPv6)
    dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
    serverName: (process.env.SERVER_NAME || 'Chat').trim().slice(0, 40) || 'Chat',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    historySize: Math.max(10, int('HISTORY_SIZE', 1000)), // Nachrichten pro Raum
    maxRooms: Math.max(1, int('MAX_ROOMS', 100)),
    maxText: Math.max(1, int('MAX_MESSAGE_LENGTH', 2000)),
    uploads: bool('ENABLE_UPLOADS', true),
    maxUploadBytes: int('MAX_UPLOAD_MB', 5) * 1024 * 1024,
    maxUploadDirBytes: int('MAX_UPLOAD_DIR_MB', 500) * 1024 * 1024,
    maxConnectionsPerIp: Math.max(1, int('MAX_CONNECTIONS_PER_IP', 20)),
    trustProxy: bool('TRUST_PROXY', false), // X-Forwarded-For auswerten (hinter Reverse-Proxy)
    ...overrides,
  };
}

module.exports = { loadConfig };
