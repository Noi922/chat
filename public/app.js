(() => {
  'use strict';

  // ---------- kleine Helfer ----------
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function iconButton(name, label, onClick) {
    const btn = el('button', 'icon-btn');
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(icon(name));
    btn.addEventListener('click', onClick);
    return btn;
  }

  const prefs = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(`chat.${key}`);
        return value === null ? fallback : value;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`chat.${key}`, value);
      } catch {
        /* privater Modus o. Ä. – Einstellungen gelten dann nur für diese Sitzung */
      }
    },
  };

  function hue(name) {
    let h = 0;
    for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function avatar(name) {
    const node = el('div', 'avatar', [...name][0] || '?');
    node.style.setProperty('--h', hue(name));
    return node;
  }

  const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const dayKey = (ts) => new Date(ts).toDateString();

  function dayLabel(ts) {
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (dayKey(ts) === today.toDateString()) return 'Heute';
    if (dayKey(ts) === yesterday.toDateString()) return 'Gestern';
    return dayFmt.format(ts);
  }

  // ---------- Zustand ----------
  const state = {
    ws: null,
    wanted: null, // { name, room } solange eine Sitzung gewünscht ist
    joined: false,
    name: '',
    room: '',
    token: prefs.get('token', ''),
    uid: '',
    admin: false,
    topic: '',
    users: [],
    rooms: [],
    items: [], // Nachrichten, Systemzeilen und Privatnachrichten in Anzeigereihenfolge
    hasMore: false,
    replyTo: null,
    editing: null,
    unread: 0,
    retry: 0,
    typing: new Map(),
    lastTypingSent: 0,
    info: { name: 'Chat', uploads: true, maxUploadBytes: 5 * 1024 * 1024, maxText: 2000 },
    sound: prefs.get('sound', 'on') === 'on',
    notify: prefs.get('notify', 'off') === 'on',
    theme: prefs.get('theme', 'auto'),
  };

  const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
  const EMOJIS = (
    '😀 😄 😁 😂 🤣 😊 😉 😍 😘 😎 🤔 😐 😴 😢 😭 😡 🤯 🥳 😇 🙃 😅 😬 🤗 🤩 ' +
    '👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 👀 ❤️ 🔥 ✨ 🎉 💯 ✅ ❌ ⚡ 💡 🚀 ☕ 🍕 🍻 🎂 🐱 🐶 🌍 ☀️ 🌙 ⭐'
  ).split(' ');

  // ---------- Textformatierung (immer als DOM-Knoten, nie als HTML) ----------
  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~)|(https?:\/\/[^\s<>"']+)|(@[\p{L}\p{N}_.-]+)/gu;

  function formatInline(text, target) {
    let last = 0;
    for (const match of text.matchAll(INLINE_RE)) {
      let token = match[0];
      if (match.index > last) target.append(text.slice(last, match.index));
      last = match.index + token.length;
      if (match[1]) target.append(el('code', '', token.slice(1, -1)));
      else if (match[2]) target.append(el('strong', '', token.slice(2, -2)));
      else if (match[3]) target.append(el('em', '', token.slice(1, -1)));
      else if (match[4]) target.append(el('s', '', token.slice(2, -2)));
      else if (match[5]) {
        const trimmed = token.replace(/[.,;:!?)\]]+$/, '');
        last -= token.length - trimmed.length;
        token = trimmed;
        const link = el('a', '', token);
        link.href = token;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        target.append(link);
      } else {
        const clean = token.replace(/[.-]+$/, '');
        last -= token.length - clean.length;
        target.append(el('span', 'at', clean));
      }
    }
    if (last < text.length) target.append(text.slice(last));
  }

  function formatText(text) {
    const fragment = document.createDocumentFragment();
    const parts = text.split(/```/);
    parts.forEach((part, index) => {
      const isCode = index % 2 === 1 && index < parts.length - 1;
      if (isCode) {
        const pre = el('pre');
        pre.append(el('code', '', part.replace(/^\n+|\n+$/g, '')));
        fragment.append(pre);
      } else {
        const segment = index % 2 === 1 ? '```' + part : part; // nicht geschlossener Codeblock
        formatInline(index > 0 ? segment.replace(/^\n/, '') : segment, fragment);
      }
    });
    return fragment;
  }

  function mentionsMe(text) {
    if (!state.name || !text) return false;
    const lower = text.toLowerCase();
    const needle = '@' + state.name.toLowerCase();
    let index = lower.indexOf(needle);
    while (index !== -1) {
      const next = lower[index + needle.length];
      if (!next || !/[\p{L}\p{N}_]/u.test(next)) return true;
      index = lower.indexOf(needle, index + 1);
    }
    return false;
  }

  // ---------- Darstellung der Nachrichtenliste ----------
  const box = $('messages');
  const list = $('messageList');
  const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const scrollDown = () => {
    box.scrollTop = box.scrollHeight;
  };

  function isGrouped(item, prev) {
    return Boolean(
      prev && prev.type === 'message' && item.type === 'message' &&
      prev.uid === item.uid && prev.name === item.name &&
      !prev.kind && !item.kind && !item.replyTo &&
      item.ts - prev.ts < 5 * 60 * 1000 && dayKey(prev.ts) === dayKey(item.ts),
    );
  }

  function buildMessage(item, grouped) {
    const own = item.uid === state.uid;
    const node = el('article', 'msg');
    node.dataset.id = item.id;
    if (grouped) node.classList.add('grouped');
    if (item.kind === 'action') node.classList.add('action');
    if (!own && mentionsMe(item.text)) node.classList.add('mention');

    node.append(avatar(item.name));
    const body = el('div', 'body');
    const head = el('div', 'head');
    const author = el('span', 'author', item.name);
    author.style.setProperty('--h', hue(item.name));
    const time = el('time', '', timeFmt.format(item.ts));
    time.title = fullFmt.format(item.ts);
    head.append(author, time);
    body.append(head);

    if (item.replyTo) {
      const quote = el('button', 'quote');
      quote.type = 'button';
      quote.append(el('b', '', item.replyTo.name), ' ' + item.replyTo.text.replace(/\s+/g, ' '));
      quote.addEventListener('click', () => flash(item.replyTo.id));
      body.append(quote);
    }
    if (item.text) {
      const text = el('div', 'text');
      if (item.kind === 'action') text.append(`${item.name} `);
      text.append(formatText(item.text));
      if (item.editedAt) {
        const edited = el('span', 'edited', ' (bearbeitet)');
        edited.title = fullFmt.format(item.editedAt);
        text.append(edited);
      }
      body.append(text);
    }
    if (item.image) {
      const shot = el('button', 'shot');
      shot.type = 'button';
      shot.setAttribute('aria-label', 'Bild vergrößern');
      const img = el('img');
      img.src = item.image;
      img.alt = `Bild von ${item.name}`;
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        if (state.stick) scrollDown();
      });
      shot.append(img);
      shot.addEventListener('click', () => openLightbox(item.image));
      body.append(shot);
    }

    const reactions = el('div', 'reactions');
    for (const [emoji, names] of Object.entries(item.reactions || {})) {
      const chip = el('button', 'reaction');
      chip.type = 'button';
      if (names.includes(state.name)) chip.classList.add('mine');
      chip.title = names.join(', ');
      chip.append(emoji, el('span', '', String(names.length)));
      chip.addEventListener('click', () => sendJson({ type: 'react', id: item.id, emoji }));
      reactions.append(chip);
    }
    body.append(reactions);
    node.append(body);

    const tools = el('div', 'tools');
    tools.append(
      iconButton('smile', 'Reagieren', (event) => {
        event.stopPropagation();
        toggleQuick(node, item);
      }),
      iconButton('reply', 'Antworten', () => startReply(item)),
    );
    if (own && item.text) tools.append(iconButton('edit', 'Bearbeiten', () => startEdit(item)));
    if (own || state.admin) {
      tools.append(
        iconButton('trash', 'Löschen', () => {
          if (confirm('Diese Nachricht wirklich löschen?')) sendJson({ type: 'delete', id: item.id });
        }),
      );
    }
    node.append(tools);
    return node;
  }

  function buildItem(item, prev) {
    if (item.type === 'message') {
      item.grouped = isGrouped(item, prev);
      return buildMessage(item, item.grouped);
    }
    if (item.type === 'dm') {
      const node = el('div', 'dm');
      const outgoing = item.from === state.name;
      node.append(el('div', 'head', outgoing ? `🔒 Privat an ${item.to} · ${timeFmt.format(item.ts)}` : `🔒 Privat von ${item.from} · ${timeFmt.format(item.ts)}`));
      const text = el('div', 'text');
      text.append(formatText(item.text));
      node.append(text);
      return node;
    }
    return el('div', item.help ? 'sys help' : 'sys', item.text);
  }

  function needsDay(item, prev) {
    return item.ts && (!prev || !prev.ts || dayKey(prev.ts) !== dayKey(item.ts));
  }

  function renderAll() {
    closeQuick();
    const fragment = document.createDocumentFragment();
    let prev = null;
    for (const item of state.items) {
      if (needsDay(item, prev)) fragment.append(el('div', 'day', dayLabel(item.ts)));
      item.el = buildItem(item, prev);
      fragment.append(item.el);
      prev = item;
    }
    if (!state.items.length) {
      const empty = el('div', 'empty');
      empty.append(el('b', '', `Willkommen in #${state.room}`), 'Noch keine Nachrichten – schreib die erste!');
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    $('loadMore').hidden = !state.hasMore;
  }

  function appendItem(item) {
    const stick = atBottom();
    const prev = state.items[state.items.length - 1] || null;
    if (!prev) list.replaceChildren();
    state.items.push(item);
    if (needsDay(item, prev)) list.append(el('div', 'day', dayLabel(item.ts)));
    item.el = buildItem(item, prev);
    list.append(item.el);
    if (stick || item.uid === state.uid) scrollDown();
    return stick;
  }

  function refreshMessage(item) {
    if (!item.el) return;
    const stick = atBottom();
    const node = buildMessage(item, item.grouped);
    item.el.replaceWith(node);
    item.el = node;
    if (stick) scrollDown();
  }

  const findMessage = (id) => state.items.find((item) => item.type === 'message' && item.id === id);

  function flash(id) {
    const item = findMessage(id);
    if (!item || !item.el) return;
    item.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    item.el.classList.add('mention');
    setTimeout(() => refreshMessage(item), 1600);
  }

  function localLine(text, help) {
    appendItem({ type: 'system', text, help });
    scrollDown();
  }

  // Schnellreaktionen direkt an der Nachricht
  let quickEl = null;
  function closeQuick() {
    if (!quickEl) return;
    quickEl.parentElement && quickEl.parentElement.classList.remove('open');
    quickEl.remove();
    quickEl = null;
  }
  function toggleQuick(node, item) {
    const wasHere = quickEl && quickEl.parentElement === node;
    closeQuick();
    if (wasHere) return;
    quickEl = el('div', 'quick');
    for (const emoji of QUICK) {
      const btn = el('button', '', emoji);
      btn.type = 'button';
      btn.setAttribute('aria-label', `Mit ${emoji} reagieren`);
      btn.addEventListener('click', () => {
        sendJson({ type: 'react', id: item.id, emoji });
        closeQuick();
      });
      quickEl.append(btn);
    }
    node.classList.add('open');
    node.append(quickEl);
  }

  // ---------- Seitenleiste ----------
  function renderRooms() {
    $('roomList').replaceChildren(
      ...state.rooms.map((room) => {
        const li = el('li');
        const btn = el('button', room.name === state.room ? 'active' : '');
        btn.type = 'button';
        btn.append(el('span', 'hash', '#'), el('span', 'label', room.name));
        if (room.count) btn.append(el('span', 'badge', String(room.count)));
        btn.addEventListener('click', () => switchRoom(room.name));
        li.append(btn);
        return li;
      }),
    );
  }

  function renderUsers() {
    $('userCount').textContent = `· ${state.users.length}`;
    $('userList').replaceChildren(
      ...state.users.map((user) => {
        const li = el('li');
        const btn = el('button');
        btn.type = 'button';
        const isMe = user.name === state.name;
        btn.title = isMe ? 'Das bist du' : `Privatnachricht an ${user.name}`;
        btn.append(avatar(user.name), el('span', 'label', isMe ? `${user.name} (du)` : user.name));
        if (user.admin) btn.append(el('span', 'tag', 'Admin'));
        if (!isMe) {
          btn.addEventListener('click', () => {
            setInput(`/msg ${user.name} `);
            closeMenu();
          });
        }
        li.append(btn);
        return li;
      }),
    );
  }

  function renderMe() {
    $('meName').textContent = state.name;
    $('meRole').textContent = state.admin ? 'Admin' : 'Online';
    const node = avatar(state.name);
    node.id = 'meAvatar';
    $('meAvatar').replaceWith(node);
  }

  function renderHeader() {
    $('roomTitle').textContent = `# ${state.room}`;
    $('roomTopic').textContent = state.topic || 'Thema hinzufügen …';
    document.title = (state.unread ? `(${state.unread}) ` : '') + (state.joined ? `#${state.room} · ` : '') + state.info.name;
  }

  function renderTyping() {
    const names = [...state.typing.keys()];
    let text = '';
    if (names.length === 1) text = `${names[0]} schreibt …`;
    else if (names.length === 2) text = `${names[0]} und ${names[1]} schreiben …`;
    else if (names.length > 2) text = 'Mehrere Personen schreiben …';
    $('typing').textContent = text;
  }

  function stopTyping(name) {
    const timer = state.typing.get(name);
    if (timer) clearTimeout(timer);
    state.typing.delete(name);
    renderTyping();
  }

  const openMenu = () => {
    $('app').classList.add('menu-open');
    $('backdrop').hidden = false;
  };
  const closeMenu = () => {
    $('app').classList.remove('menu-open');
    $('backdrop').hidden = true;
  };

  // ---------- Einstellungen: Design, Ton, Benachrichtigungen ----------
  function applyToggles() {
    if (state.theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = state.theme;
    const themeLabel = { auto: 'Design: automatisch', light: 'Design: hell', dark: 'Design: dunkel' }[state.theme];
    $('themeBtn').title = themeLabel;
    $('themeBtn').setAttribute('aria-label', themeLabel);
    const soundLabel = state.sound ? 'Ton: an' : 'Ton: aus';
    $('soundBtn').title = soundLabel;
    $('soundBtn').setAttribute('aria-label', soundLabel);
    $('soundBtn').classList.toggle('off', !state.sound);
    const notifyLabel = state.notify ? 'Benachrichtigungen: an' : 'Benachrichtigungen: aus';
    $('notifyBtn').title = notifyLabel;
    $('notifyBtn').setAttribute('aria-label', notifyLabel);
    $('notifyBtn').classList.toggle('off', !state.notify);
  }

  let audio = null;
  function beep() {
    if (!state.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audio.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.12);
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.26);
    } catch {
      /* kein Audio verfügbar */
    }
  }

  function desktopNotify(title, body) {
    if (!state.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const note = new Notification(title, { body: body.slice(0, 160), tag: 'chat' });
      note.onclick = () => {
        window.focus();
        note.close();
      };
    } catch {
      /* z. B. auf Mobilgeräten nicht unterstützt */
    }
  }

  function markUnread(important, title, body) {
    if (document.hidden || !state.stick) {
      state.unread++;
      renderHeader();
      if (!state.stick) $('jumpBtn').hidden = false;
    }
    if (important) {
      beep();
      desktopNotify(title, body);
    }
  }

  function clearUnread() {
    if (!state.unread && $('jumpBtn').hidden) return;
    state.unread = 0;
    $('jumpBtn').hidden = true;
    renderHeader();
  }

  // ---------- Verbindung ----------
  function sendJson(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showError('Keine Verbindung zum Server.');
      return false;
    }
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    state.ws = ws;
    ws.addEventListener('open', () => {
      state.retry = 0;
      if (state.wanted) ws.send(JSON.stringify({ type: 'join', ...state.wanted, token: state.token }));
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (handlers[msg.type]) handlers[msg.type](msg);
    });
    ws.addEventListener('close', () => {
      if (state.ws !== ws) return;
      state.ws = null;
      if (!state.wanted) return;
      if (state.joined) $('connection').hidden = false;
      else if (!$('loginError').textContent) $('loginError').textContent = 'Der Server ist nicht erreichbar – neuer Versuch …';
      setTimeout(() => state.wanted && !state.ws && connect(), Math.min(1000 * 2 ** state.retry++, 15000));
    });
  }

  function endSession(message) {
    state.wanted = null;
    state.joined = false;
    if (state.ws) state.ws.close();
    state.ws = null;
    state.items = [];
    state.typing.clear();
    state.unread = 0;
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginButton').disabled = false;
    $('loginError').textContent = message || '';
    $('connection').hidden = true;
    document.title = state.info.name;
    cancelContext();
    closeMenu();
  }

  function switchRoom(room) {
    closeMenu();
    if (room === state.room) return;
    sendJson({ type: 'switch', room });
  }

  const handlers = {
    joined(msg) {
      const sameRoom = state.joined && state.room === msg.room;
      Object.assign(state, {
        joined: true, name: msg.name, room: msg.room, token: msg.token, uid: msg.uid, admin: msg.admin,
        topic: msg.topic, users: msg.users, rooms: msg.rooms, hasMore: msg.hasMore,
      });
      state.wanted = { name: msg.name, room: msg.room };
      prefs.set('token', msg.token);
      prefs.set('name', msg.name);
      prefs.set('room', msg.room);
      state.items = msg.history.map((m) => ({ type: 'message', ...m }));
      state.typing.clear();
      if (!sameRoom) cancelContext();
      $('login').hidden = true;
      $('app').hidden = false;
      $('connection').hidden = true;
      $('loginButton').disabled = false;
      $('attachBtn').hidden = !state.info.uploads;
      if (decodeURIComponent(location.hash.slice(1)) !== msg.room) history.replaceState(null, '', `#${encodeURIComponent(msg.room)}`);
      renderAll();
      renderRooms();
      renderUsers();
      renderMe();
      renderTyping();
      state.unread = 0;
      renderHeader();
      state.stick = true;
      scrollDown();
      $('jumpBtn').hidden = true;
      if (window.matchMedia('(min-width: 761px)').matches) $('input').focus();
    },

    message(msg) {
      const item = { type: 'message', ...msg.message };
      stopTyping(item.name);
      state.stick = appendItem(item);
      if (item.uid === state.uid) return;
      const mention = mentionsMe(item.text);
      markUnread(mention, `${item.name} in #${state.room}`, item.text || 'Bild');
    },

    edited(msg) {
      const item = findMessage(msg.id);
      if (!item) return;
      item.text = msg.text;
      item.editedAt = msg.editedAt;
      refreshMessage(item);
    },

    deleted(msg) {
      const index = state.items.findIndex((item) => item.type === 'message' && item.id === msg.id);
      if (index === -1) return;
      state.items.splice(index, 1);
      if (state.editing === msg.id || (state.replyTo && state.replyTo.id === msg.id)) cancelContext();
      const top = box.scrollTop;
      renderAll();
      box.scrollTop = top;
    },

    reactions(msg) {
      const item = findMessage(msg.id);
      if (!item) return;
      item.reactions = msg.reactions;
      refreshMessage(item);
    },

    history(msg) {
      const height = box.scrollHeight;
      const top = box.scrollTop;
      state.items.unshift(...msg.messages.map((m) => ({ type: 'message', ...m })));
      state.hasMore = msg.hasMore;
      renderAll();
      box.scrollTop = top + (box.scrollHeight - height);
      $('loadMore').disabled = false;
    },

    users(msg) {
      state.users = msg.users;
      for (const name of state.typing.keys()) {
        if (!msg.users.some((user) => user.name === name)) stopTyping(name);
      }
      renderUsers();
    },

    rooms(msg) {
      state.rooms = msg.rooms;
      renderRooms();
    },

    typing(msg) {
      stopTyping(msg.name);
      state.typing.set(msg.name, setTimeout(() => stopTyping(msg.name), 3500));
      renderTyping();
    },

    system(msg) {
      state.stick = appendItem({ type: 'system', text: msg.text, ts: msg.ts });
    },

    dm(msg) {
      state.stick = appendItem({ type: 'dm', ...msg });
      if (msg.from !== state.name) markUnread(true, `Privatnachricht von ${msg.from}`, msg.text);
      else scrollDown();
    },

    topic(msg) {
      state.topic = msg.topic;
      renderHeader();
    },

    nick(msg) {
      state.name = msg.name;
      state.wanted = { name: msg.name, room: state.room };
      prefs.set('name', msg.name);
      renderMe();
      renderAll();
    },

    admin(msg) {
      state.admin = msg.admin;
      renderMe();
      const top = box.scrollTop;
      renderAll();
      box.scrollTop = top;
      localLine('Du hast jetzt Admin-Rechte: fremde Nachrichten löschen, /kick <Name>, /delroom <Raum>.');
    },

    error(msg) {
      if (state.joined) return showError(msg.text);
      state.wanted = null;
      $('loginError').textContent = msg.text;
      $('loginButton').disabled = false;
    },

    kicked() {
      endSession('Du wurdest von einem Admin aus dem Chat entfernt.');
    },

    replaced() {
      endSession('Du hast dich in einem anderen Tab oder Fenster angemeldet.');
    },
  };

  let errorTimer = null;
  function showError(text) {
    $('chatError').textContent = text;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      $('chatError').textContent = '';
    }, 5000);
  }

  // ---------- Eingabe ----------
  const input = $('input');

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  function setInput(text) {
    input.value = text;
    autoGrow();
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  function showContext(label, text) {
    $('contextLabel').textContent = label;
    $('contextText').textContent = text.replace(/\s+/g, ' ');
    $('contextBar').hidden = false;
  }

  function cancelContext() {
    const wasEditing = state.editing !== null;
    state.replyTo = null;
    state.editing = null;
    $('contextBar').hidden = true;
    if (wasEditing) setInput('');
  }

  function startReply(item) {
    cancelContext();
    state.replyTo = item;
    showContext(`Antwort an ${item.name}:`, item.text || 'Bild');
    input.focus();
  }

  function startEdit(item) {
    cancelContext();
    state.editing = item.id;
    showContext('Nachricht bearbeiten', '· Enter speichert, Esc bricht ab');
    setInput(item.text);
  }

  const HELP = [
    'Befehle',
    '/nick <Name> – Namen ändern',
    '/me <Text> – Aktion senden (z. B. /me winkt)',
    '/msg <Name> <Text> – Privatnachricht',
    '/join <Raum> – Raum wechseln oder neu erstellen',
    '/topic <Text> – Thema des Raums setzen',
    '/shrug – ¯\\_(ツ)_/¯',
    '/clear – eigene Ansicht leeren',
    '/admin <Passwort> – Admin-Rechte holen',
    '/kick <Name>, /delroom <Raum> – nur für Admins',
    '',
    'Formatierung: **fett**, *kursiv*, ~~durchgestrichen~~, `Code`, ```Codeblock```, @Name erwähnt jemanden.',
    'Die ausführliche Anleitung öffnest du über das Fragezeichen oben rechts.',
    'Tasten: Enter sendet, Umschalt+Enter macht eine neue Zeile, Tab vervollständigt Namen, ↑ bearbeitet deine letzte Nachricht.',
  ].join('\n');

  function runCommand(line) {
    const [, command, rest = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(line) || [];
    const arg = rest.trim();
    switch ((command || '').toLowerCase()) {
      case 'help':
      case 'hilfe':
        localLine(HELP, true);
        return true;
      case 'nick':
        return sendJson({ type: 'nick', name: arg });
      case 'me':
        return arg ? sendJson({ type: 'message', text: arg, action: true }) : true;
      case 'msg':
      case 'w': {
        const [, to, text] = /^@?(\S+)\s+([\s\S]+)$/.exec(arg) || [];
        if (!to) {
          showError('So geht es: /msg <Name> <Text>');
          return false;
        }
        return sendJson({ type: 'dm', to, text });
      }
      case 'join':
        return arg ? sendJson({ type: 'switch', room: arg }) : true;
      case 'topic':
        return sendJson({ type: 'topic', text: arg });
      case 'admin':
        return sendJson({ type: 'admin', password: arg });
      case 'kick':
        return sendJson({ type: 'kick', name: arg.replace(/^@/, '') });
      case 'delroom':
        return sendJson({ type: 'delroom', room: arg });
      case 'shrug':
        return sendJson({ type: 'message', text: `${arg} ¯\\_(ツ)_/¯`.trim() });
      case 'clear':
        state.items = [];
        state.hasMore = false;
        renderAll();
        return true;
      default:
        showError(`Unbekannter Befehl „/${command}" – /help zeigt alle Befehle.`);
        return false;
    }
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    let ok;
    if (state.editing !== null) {
      ok = sendJson({ type: 'edit', id: state.editing, text });
      if (ok) cancelContext();
      return;
    }
    if (text.startsWith('/') && !text.startsWith('//')) {
      ok = runCommand(text);
    } else {
      const payload = { type: 'message', text: text.startsWith('//') ? text.slice(1) : text };
      if (state.replyTo) payload.replyTo = state.replyTo.id;
      ok = sendJson(payload);
      if (ok) cancelContext();
    }
    if (ok) {
      setInput('');
      state.lastTypingSent = 0; // nächstes Tippen sofort wieder anzeigen
    }
  }

  // Namen mit Tab vervollständigen
  function completeName() {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const match = /(^|\s)(@?)([\p{L}\p{N}_.-]+)$/u.exec(before);
    if (!match) return false;
    const partial = match[3].toLowerCase();
    const hit = state.users.find((user) => user.name !== state.name && user.name.toLowerCase().startsWith(partial));
    if (!hit) return false;
    const start = caret - match[3].length - match[2].length;
    const isCommandArg = /^\/(msg|w|kick)\s+@?\S*$/i.test(before);
    const insert = (isCommandArg ? '' : '@') + hit.name + ' ';
    input.value = input.value.slice(0, start) + insert + input.value.slice(caret);
    const position = start + insert.length;
    input.setSelectionRange(position, position);
    return true;
  }

  async function uploadImage(file) {
    if (!state.info.uploads) return showError('Bilder sind auf diesem Server deaktiviert.');
    if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return showError('Nur Bilder (PNG, JPEG, GIF, WebP) sind erlaubt.');
    if (file.size > state.info.maxUploadBytes) {
      return showError(`Das Bild ist zu groß (max. ${Math.floor(state.info.maxUploadBytes / 1024 / 1024)} MB).`);
    }
    $('attachBtn').disabled = true;
    try {
      const response = await fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': file.type, 'X-Chat-Token': state.token },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return showError(result.error || 'Hochladen fehlgeschlagen.');
      const payload = { type: 'message', image: result.url, text: state.editing === null ? input.value.trim() : '' };
      if (state.replyTo) payload.replyTo = state.replyTo.id;
      if (sendJson(payload) && state.editing === null) {
        cancelContext();
        setInput('');
      }
    } catch {
      showError('Hochladen fehlgeschlagen – keine Verbindung.');
    } finally {
      $('attachBtn').disabled = false;
    }
  }

  function openLightbox(src) {
    $('lightbox').querySelector('img').src = src;
    $('lightbox').hidden = false;
  }

  // ---------- Ereignisse ----------
  $('loginForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('loginName').value.trim();
    const room = $('loginRoom').value.trim() || 'lobby';
    if (!name) {
      $('loginError').textContent = 'Bitte gib einen Namen ein.';
      return $('loginName').focus();
    }
    $('loginError').textContent = '';
    $('loginButton').disabled = true;
    state.wanted = { name, room };
    if (state.ws && state.ws.readyState === WebSocket.OPEN) sendJson({ type: 'join', name, room, token: state.token });
    else if (!state.ws) connect();
  });

  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === 'Tab' && !event.shiftKey && input.value) {
      if (completeName()) event.preventDefault();
    } else if (event.key === 'Escape') {
      if (state.editing !== null || state.replyTo) cancelContext();
      $('emojiPicker').hidden = true;
    } else if (event.key === 'ArrowUp' && !input.value) {
      const mine = [...state.items].reverse().find((item) => item.type === 'message' && item.uid === state.uid && item.text);
      if (mine) {
        event.preventDefault();
        startEdit(mine);
      }
    }
  });

  input.addEventListener('input', () => {
    autoGrow();
    const now = Date.now();
    if (input.value && !input.value.startsWith('/') && state.editing === null && now - state.lastTypingSent > 2500) {
      state.lastTypingSent = now;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send('{"type":"typing"}');
    }
  });

  input.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData ? event.clipboardData.files : [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      event.preventDefault();
      uploadImage(file);
    }
  });

  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => {
    const file = $('fileInput').files[0];
    $('fileInput').value = '';
    if (file) uploadImage(file);
  });

  // Bilder per Drag & Drop
  let dragDepth = 0;
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (event) => {
    if (!state.joined || !hasFiles(event) || !state.info.uploads) return;
    dragDepth++;
    $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').hidden = true;
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    if (state.joined && event.dataTransfer.files[0]) uploadImage(event.dataTransfer.files[0]);
  });

  // Emoji-Auswahl
  for (const emoji of EMOJIS) {
    const btn = el('button', '', emoji);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const start = input.selectionStart;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(input.selectionEnd);
      const position = start + emoji.length;
      input.focus();
      input.setSelectionRange(position, position);
      autoGrow();
    });
    $('emojiPicker').append(btn);
  }
  $('emojiBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    $('emojiPicker').hidden = !$('emojiPicker').hidden;
  });
  document.addEventListener('click', (event) => {
    if (!$('emojiPicker').hidden && !$('emojiPicker').contains(event.target)) $('emojiPicker').hidden = true;
    if (quickEl && !quickEl.contains(event.target)) closeQuick();
  });

  $('contextCancel').addEventListener('click', cancelContext);
  $('lightbox').addEventListener('click', () => {
    $('lightbox').hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('lightbox').hidden = true;
      closeQuick();
      closeMenu();
    }
  });

  $('loadMore').addEventListener('click', () => {
    const first = state.items.find((item) => item.type === 'message');
    if (first && sendJson({ type: 'history', before: first.id })) $('loadMore').disabled = true;
  });

  box.addEventListener('scroll', () => {
    state.stick = atBottom();
    if (state.stick && !document.hidden) clearUnread();
  });
  $('jumpBtn').addEventListener('click', () => {
    scrollDown();
    clearUnread();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && atBottom()) clearUnread();
  });

  $('newRoomForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const room = $('newRoom').value.trim();
    if (!room) return;
    $('newRoom').value = '';
    sendJson({ type: 'switch', room });
    closeMenu();
  });

  $('roomTopic').addEventListener('click', () => {
    const topic = prompt('Thema für diesen Raum (leer lassen zum Entfernen):', state.topic);
    if (topic !== null) sendJson({ type: 'topic', text: topic });
  });

  $('menuBtn').addEventListener('click', openMenu);
  $('backdrop').addEventListener('click', closeMenu);
  $('logoutBtn').addEventListener('click', () => endSession(''));

  $('themeBtn').addEventListener('click', () => {
    state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme] || 'auto';
    prefs.set('theme', state.theme);
    applyToggles();
  });
  $('soundBtn').addEventListener('click', () => {
    state.sound = !state.sound;
    prefs.set('sound', state.sound ? 'on' : 'off');
    applyToggles();
    beep();
  });
  $('notifyBtn').addEventListener('click', async () => {
    if (!state.notify) {
      if (!('Notification' in window)) return showError('Dieser Browser unterstützt keine Benachrichtigungen.');
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') return showError('Benachrichtigungen wurden im Browser blockiert.');
    }
    state.notify = !state.notify;
    prefs.set('notify', state.notify ? 'on' : 'off');
    applyToggles();
  });

  window.addEventListener('hashchange', () => {
    const room = decodeURIComponent(location.hash.slice(1));
    if (state.joined && room && room !== state.room) sendJson({ type: 'switch', room });
  });

  // ---------- Start ----------
  function hashRoom() {
    try {
      return decodeURIComponent(location.hash.slice(1));
    } catch {
      return '';
    }
  }

  applyToggles();
  $('loginName').value = prefs.get('name', '');
  $('loginRoom').value = hashRoom() || prefs.get('room', '') || 'lobby';
  ($('loginName').value ? $('loginButton') : $('loginName')).focus();

  fetch('/api/info')
    .then((response) => response.json())
    .then((info) => {
      Object.assign(state.info, info);
      $('loginTitle').textContent = state.info.name;
      $('brandName').textContent = state.info.name;
      if (!state.joined) document.title = state.info.name;
      input.maxLength = state.info.maxText;
      $('attachBtn').hidden = !state.info.uploads;
    })
    .catch(() => {});
})();
