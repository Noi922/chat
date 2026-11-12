// Übernimmt das im Chat gewählte Design (hell/dunkel) und den Servernamen
(() => {
  try {
    const theme = localStorage.getItem('chat.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {
    /* ohne Speicherzugriff gilt die Systemeinstellung */
  }
  fetch('/api/info')
    .then((response) => response.json())
    .then((info) => {
      if (info && info.name) document.getElementById('serverName').textContent = info.name;
    })
    .catch(() => {});
})();
