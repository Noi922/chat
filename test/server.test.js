'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function startServer(dataDir, overrides = {}) {
  const app = createApp(loadConfig({ port: 0, host: '127.0.0.1', dataDir, adminPassword: 'geheim', ...overrides }));
  const port = await app.listen();
  return { app, port };
}

// Test-Client: sammelt eingehende Nachrichten und erlaubt gezieltes Warten
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const index = waiters.findIndex((w) => w.match(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (payload) => ws.send(JSON.stringify(payload)),
    next(type, where = () => true) {
      const match = (msg) => msg.type === type && where(msg);
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Zeitüberschreitung beim Warten auf „${type}"`)), 3000);
        waiters.push({ match, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
      });
    },
    close: () => new Promise((resolve) => (ws.once('close', resolve), ws.close())),
  };
}

async function join(port, name, room = 'lobby', token) {
  const c = client(port);
  await c.opened;
  c.send({ type: 'join', name, room, token });
  c.info = await c.next('joined');
  return c;
}

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('Chat-Server', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  let { app, port } = await startServer(dataDir);
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test('liefert Web-Client, Healthcheck und blockt Pfad-Tricks', async () => {
    const index = await request(port, 'GET', '/');
    assert.strictEqual(index.status, 200);
    assert.match(index.headers['content-security-policy'], /default-src 'self'/);
    const health = JSON.parse((await request(port, 'GET', '/healthz')).body);
    assert.strictEqual(health.status, 'ok');
    assert.notStrictEqual((await request(port, 'GET', '/../server.js')).status, 200);
    assert.notStrictEqual((await request(port, 'GET', '/%2e%2e/package.json')).status, 200);
    assert.strictEqual((await request(port, 'GET', '/uploads/../state.json')).status, 404);
  });

  await t.test('prüft Namen und Räume', async () => {
    const c = client(port);
    await c.opened;
    c.send({ type: 'join', name: 'a b', room: 'lobby' });
    assert.match((await c.next('error')).text, /Namen brauchen/);
    c.send({ type: 'join', name: 'Anna', room: 'böse/raum' });
    assert.match((await c.next('error')).text, /Raumnamen/);
    c.send({ type: 'message', text: 'ohne Beitritt' });
    assert.match((await c.next('error')).text, /keinem Raum/);
    await c.close();
  });

  await t.test('Nachrichten, Räume, Antworten, Bearbeiten, Löschen, Reaktionen', async () => {
    const anna = await join(port, 'Anna');
    const ben = await join(port, 'Ben');
    const cem = await join(port, 'Cem', 'Andere');
    assert.strictEqual(cem.info.room, 'andere');
    assert.deepStrictEqual(ben.info.users.map((u) => u.name), ['Anna', 'Ben']);

    const dup = client(port);
    await dup.opened;
    dup.send({ type: 'join', name: 'anna', room: 'lobby' });
    assert.match((await dup.next('error')).text, /bereits vergeben/);
    await dup.close();

    anna.send({ type: 'message', text: '  Hallo <b>Welt</b>\u0000  ' });
    const first = (await ben.next('message')).message;
    assert.strictEqual(first.text, 'Hallo <b>Welt</b>');
    assert.strictEqual(first.name, 'Anna');
    await anna.next('message');

    ben.send({ type: 'message', text: 'Antwort', replyTo: first.id });
    const reply = (await anna.next('message')).message;
    assert.deepStrictEqual(reply.replyTo, { id: first.id, name: 'Anna', text: 'Hallo <b>Welt</b>' });

    // Fremde Nachrichten dürfen nicht bearbeitet oder gelöscht werden
    ben.send({ type: 'edit', id: first.id, text: 'gehackt' });
    assert.match((await ben.next('error')).text, /nur eigene/);
    ben.send({ type: 'delete', id: first.id });
    assert.match((await ben.next('error')).text, /nur eigene/);

    anna.send({ type: 'edit', id: first.id, text: 'Hallo zusammen' });
    const edited = await ben.next('edited');
    assert.strictEqual(edited.text, 'Hallo zusammen');

    ben.send({ type: 'react', id: first.id, emoji: '👍' });
    assert.deepStrictEqual((await anna.next('reactions')).reactions, { '👍': ['Ben'] });
    ben.send({ type: 'react', id: first.id, emoji: '👍' });
    assert.deepStrictEqual((await anna.next('reactions')).reactions, {});
    ben.send({ type: 'react', id: first.id, emoji: '<script>' });
    assert.match((await ben.next('error')).text, /Emoji/);

    // Der andere Raum hat nichts davon mitbekommen
    cem.send({ type: 'history' });
    assert.deepStrictEqual((await cem.next('history')).messages, []);

    // Privatnachricht erreicht nur die beiden Beteiligten, auch raumübergreifend
    anna.send({ type: 'dm', to: 'cem', text: 'psst' });
    assert.strictEqual((await cem.next('dm')).text, 'psst');
    assert.strictEqual((await anna.next('dm')).to, 'Cem');

    // Admin: falsches Passwort, dann richtiges, dann fremde Nachricht löschen und kicken
    ben.send({ type: 'kick', name: 'Anna' });
    assert.match((await ben.next('error')).text, /Admin-Rechte/);
    ben.send({ type: 'admin', password: 'falsch' });
    assert.match((await ben.next('error')).text, /Falsches Passwort/);
    ben.send({ type: 'admin', password: 'geheim' });
    assert.strictEqual((await ben.next('admin')).admin, true);
    ben.send({ type: 'delete', id: first.id });
    assert.strictEqual((await anna.next('deleted')).id, first.id);
    ben.send({ type: 'kick', name: 'Cem' });
    await cem.next('kicked');

    // Themen und Raumwechsel
    anna.send({ type: 'topic', text: 'Tests' });
    assert.strictEqual((await ben.next('topic')).topic, 'Tests');
    anna.send({ type: 'switch', room: 'neu' });
    assert.strictEqual((await anna.next('joined')).room, 'neu');
    assert.deepStrictEqual((await ben.next('users', (m) => m.users.length === 1)).users.map((u) => u.name), ['Ben']);

    await Promise.all([anna.close(), ben.close()]);
  });

  await t.test('Spam-Schutz greift', async () => {
    const dana = await join(port, 'Dana', 'spam');
    for (let i = 0; i < 12; i++) dana.send({ type: 'message', text: `spam ${i}` });
    assert.match((await dana.next('error')).text, /Zu viele Nachrichten/);
    await dana.close();
  });

  await t.test('Bild-Upload: nur angemeldet, nur echte Bilder, nur eigene Uploads', async () => {
    const eva = await join(port, 'Eva', 'bilder');
    const finn = await join(port, 'Finn', 'bilder');
    const post = (token, body) => request(port, 'POST', '/upload', { headers: { 'x-chat-token': token, 'content-type': 'image/png' }, body });

    assert.strictEqual((await post('0'.repeat(32), PNG)).status, 401);
    assert.strictEqual((await post(eva.info.token, Buffer.from('<script>alert(1)</script>'))).status, 415);
    const ok = await post(eva.info.token, PNG);
    assert.strictEqual(ok.status, 201);
    const { url } = JSON.parse(ok.body);

    finn.send({ type: 'message', image: url });
    assert.match((await finn.next('error')).text, /nicht \(mehr\) verfügbar/);
    eva.send({ type: 'message', image: url, text: 'schau mal' });
    assert.strictEqual((await finn.next('message')).message.image, url);

    const served = await request(port, 'GET', url);
    assert.strictEqual(served.status, 200);
    assert.strictEqual(served.headers['content-type'], 'image/png');
    assert.ok(served.body.equals(PNG));
    await Promise.all([eva.close(), finn.close()]);
  });

  await t.test('gleiche Person ersetzt ihre alte Sitzung statt „Name vergeben"', async () => {
    const one = await join(port, 'Gina', 'tabs');
    const two = await join(port, 'Gina', 'tabs', one.info.token);
    await one.next('replaced');
    assert.strictEqual(two.info.users.length, 1);
    await two.close();
  });

  await t.test('Verlauf bleibt nach einem Neustart erhalten', async () => {
    const hugo = await join(port, 'Hugo', 'archiv');
    // 55 Nachrichten direkt in den Speicher legen (am Spam-Schutz vorbei), 5 weitere regulär senden
    const room = app.store.ensureRoom('archiv');
    for (let i = 1; i <= 55; i++) {
      room.messages.push({ id: app.store.nextId(), uid: 'x', name: 'Hugo', text: `Nachricht ${i}`, ts: Date.now() });
    }
    for (let i = 56; i <= 60; i++) hugo.send({ type: 'message', text: `Nachricht ${i}` });
    await hugo.next('message', (m) => m.message.text === 'Nachricht 60');
    await hugo.close();
    await app.close();
    ({ app, port } = await startServer(dataDir));

    const ida = await join(port, 'Ida', 'archiv');
    assert.strictEqual(ida.info.history.length, 50);
    assert.strictEqual(ida.info.hasMore, true);
    assert.strictEqual(ida.info.history[49].text, 'Nachricht 60');
    ida.send({ type: 'history', before: ida.info.history[0].id });
    const older = await ida.next('history');
    assert.strictEqual(older.messages.length, 10);
    assert.strictEqual(older.messages[0].text, 'Nachricht 1');
    assert.strictEqual(older.hasMore, false);
    assert.ok(ida.info.rooms.some((r) => r.name === 'lobby'));
    await ida.close();
  });
});
