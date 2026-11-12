'use strict';
// Dauerhafte Speicherung als JSON-Datei (keine nativen Abhängigkeiten,
// läuft dadurch auf jeder Plattform, auf der Node.js läuft).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    this.rooms = new Map(); // Raumname -> { topic, messages[] }
    this.counter = 1;
    this.dirty = false;
    this.writing = false;
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    try {
      const data = JSON.parse(raw);
      for (const [name, room] of Object.entries(data.rooms || {})) {
        this.rooms.set(name, {
          topic: typeof room.topic === 'string' ? room.topic : '',
          messages: Array.isArray(room.messages) ? room.messages : [],
        });
      }
      this.counter = Number.isInteger(data.nextId) && data.nextId > 0 ? data.nextId : 1;
      // Sicherheitsnetz: Zähler nie kleiner als die höchste vorhandene ID
      for (const room of this.rooms.values()) {
        for (const m of room.messages) if (m.id >= this.counter) this.counter = m.id + 1;
      }
    } catch (err) {
      const backup = `${this.file}.defekt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`Speicherdatei war beschädigt und wurde nach ${backup} verschoben: ${err.message}`);
    }
  }

  nextId() {
    return this.counter++;
  }

  ensureRoom(name) {
    if (!this.rooms.has(name)) this.rooms.set(name, { topic: '', messages: [] });
    return this.rooms.get(name);
  }

  serialize() {
    return JSON.stringify({ nextId: this.counter, rooms: Object.fromEntries(this.rooms) });
  }

  // Änderungen gebündelt und atomar (temporäre Datei + Umbenennen) schreiben
  save() {
    this.dirty = true;
    if (this.timer || this.writing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, 400);
    this.timer.unref();
  }

  write() {
    this.writing = true;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.promises
      .writeFile(tmp, this.serialize())
      .then(() => fs.promises.rename(tmp, this.file))
      .catch((err) => {
        this.dirty = true;
        console.error(`Speichern fehlgeschlagen: ${err.message}`);
      })
      .finally(() => {
        this.writing = false;
        if (this.dirty && !this.closed) this.save();
      });
  }

  flushSync() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.sync.tmp`;
    fs.writeFileSync(tmp, this.serialize());
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}

module.exports = { Store };
