'use strict';
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

const cfg = loadConfig();
const app = createApp(cfg);

app
  .listen()
  .then((port) => {
    console.log(`${cfg.serverName} läuft auf http://localhost:${port}`);
    console.log(`Daten: ${cfg.dataDir} · Uploads: ${cfg.uploads ? 'an' : 'aus'} · Admin: ${cfg.adminPassword ? 'eingerichtet' : 'aus'}`);
  })
  .catch((err) => {
    console.error(`Start fehlgeschlagen: ${err.message}`);
    process.exit(1);
  });

// Sauber herunterfahren (wichtig für Docker und systemd): Daten sichern, Verbindungen schließen
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} empfangen – Server wird beendet …`);
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
