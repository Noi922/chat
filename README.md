# Chat-Server

Ein selbst gehosteter Echtzeit-Chat mit Web-Oberfläche. Node.js und WebSockets, eine einzige Abhängigkeit (`ws`), keine Datenbank nötig.

**[Zur Bedienungsanleitung](ANLEITUNG.md)** – Schritt für Schritt mit Bildern, für Nutzer und Betreiber.

## Funktionen

**Chat**
- Räume mit Themen, Raumliste mit Anzahl der Personen, Links direkt in einen Raum (`/#raumname`)
- Dauerhafter Verlauf, ältere Nachrichten lassen sich nachladen
- Antworten auf Nachrichten, Bearbeiten und Löschen eigener Nachrichten
- Emoji-Reaktionen und Emoji-Auswahl
- Bilder senden per Knopf, Einfügen aus der Zwischenablage oder Drag & Drop
- Privatnachrichten, Erwähnungen mit `@Name`, Anzeige „… schreibt"
- Formatierung: `**fett**`, `*kursiv*`, `~~durchgestrichen~~`, `` `Code` ``, Codeblöcke, klickbare Links
- Befehle: `/help`, `/nick`, `/me`, `/msg`, `/join`, `/topic`, `/shrug`, `/clear`

**Oberfläche**
- Helles und dunkles Design (automatisch oder umschaltbar), für Handy und Desktop
- Ton und Desktop-Benachrichtigungen bei Erwähnungen und Privatnachrichten, Zähler für Ungelesenes im Tab-Titel
- Namen mit Tab vervollständigen, Pfeil nach oben bearbeitet die letzte eigene Nachricht
- Automatische Neuverbindung nach Verbindungsabbrüchen

**Betrieb**
- Admin-Rechte per Passwort: fremde Nachrichten löschen, `/kick <Name>`, `/delroom <Raum>`
- Spam-Schutz, Größen- und Längenbegrenzungen, Verbindungslimit pro IP-Adresse
- Bild-Uploads werden anhand ihres Inhalts geprüft; Nachrichten werden nie als HTML ausgeführt
- Healthcheck unter `/healthz`, sauberes Herunterfahren ohne Datenverlust

## Schnellstart mit Docker

```bash
git clone https://github.com/Noi922/chat.git
```

```bash
cd chat
```

```bash
docker compose up -d
```

Danach ist der Chat unter `http://localhost:3000` erreichbar. Verlauf und Bilder liegen im Docker-Volume `chat-data` und bleiben bei Updates erhalten.

Einstellungen kommen in eine Datei `.env` neben der `docker-compose.yml`:

```bash
cp .env.example .env
```

Ohne Compose:

```bash
docker build -t chat-server .
```

```bash
docker run -d --name chat -p 3000:3000 -v chat-data:/data -e ADMIN_PASSWORD=geheim chat-server
```

Das Image enthält keine nativen Module und lässt sich deshalb unverändert für x86-64 und ARM (z. B. Raspberry Pi) bauen. Der Container läuft ohne Root-Rechte und mit schreibgeschütztem Dateisystem.

## Installation ohne Docker (Linux)

Das Installationsskript richtet den Server als Dienst ein. Es ist in POSIX-Shell geschrieben und erkennt den Paketmanager der Distribution (`apt`, `dnf`, `yum`, `pacman`, `zypper`, `apk`), um bei Bedarf Node.js zu installieren.

```bash
sudo ./install.sh
```

Das Skript:

1. installiert Node.js, falls es fehlt (benötigt wird Version 18 oder neuer),
2. legt den Systembenutzer `chat` an,
3. kopiert das Programm nach `/opt/chat-server`,
4. legt die Konfiguration unter `/etc/chat-server.env` an,
5. richtet auf Systemen mit systemd den Dienst `chat-server` ein und startet ihn.

Die Daten liegen in `/var/lib/chat-server`. Nach einer Änderung der Konfiguration:

```bash
sudo systemctl restart chat-server
```

Für ein Update das Repository aktualisieren und `sudo ./install.sh` erneut ausführen; Konfiguration und Daten bleiben erhalten.

Liefert die Distribution nur ein älteres Node.js (z. B. Ubuntu 22.04), bricht das Skript mit einem Hinweis ab. Dann entweder ein neueres Node.js installieren oder Docker verwenden. Auf Systemen ohne systemd (z. B. Alpine) installiert das Skript alles und zeigt den Startbefehl für das eigene Init-System an.

## Manuell starten (Entwicklung)

```bash
npm install
```

```bash
npm start
```

Tests:

```bash
npm test
```

## Konfiguration

Alle Einstellungen sind Umgebungsvariablen.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Port des Servers |
| `HOST` | alle Schnittstellen | Adresse, an die der Server gebunden wird |
| `SERVER_NAME` | `Chat` | Angezeigter Name |
| `ADMIN_PASSWORD` | leer | Passwort für `/admin`; leer bedeutet: keine Admins |
| `DATA_DIR` | `./data` | Speicherort für Verlauf und Bilder |
| `HISTORY_SIZE` | `1000` | Gespeicherte Nachrichten pro Raum |
| `MAX_MESSAGE_LENGTH` | `2000` | Maximale Zeichen pro Nachricht |
| `MAX_ROOMS` | `100` | Maximale Anzahl Räume |
| `ENABLE_UPLOADS` | `true` | Bild-Uploads erlauben |
| `MAX_UPLOAD_MB` | `5` | Maximale Größe eines Bildes |
| `MAX_UPLOAD_DIR_MB` | `500` | Gesamter Speicher für Bilder |
| `MAX_CONNECTIONS_PER_IP` | `20` | Gleichzeitige Verbindungen pro Adresse |
| `TRUST_PROXY` | `false` | `X-Forwarded-For` auswerten (hinter einem Reverse-Proxy) |

## Öffentlich betreiben (HTTPS)

Der Server spricht selbst nur HTTP. Für den Betrieb im Internet gehört ein Reverse-Proxy mit HTTPS davor, zum Beispiel Caddy:

```
chat.example.com {
    reverse_proxy localhost:3000
}
```

Oder Nginx (wichtig sind die beiden `Upgrade`-Zeilen für WebSockets):

```nginx
server {
    server_name chat.example.com;
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

Hinter einem Proxy `TRUST_PROXY=true` setzen, damit das Verbindungslimit pro Besucher und nicht für den Proxy gilt.

## Gut zu wissen

- Es gibt keine Benutzerkonten. Wer einen freien Namen wählt, ist dabei. Der Browser merkt sich ein zufälliges Kennzeichen, damit eigene Nachrichten auch nach einem Neuladen bearbeitet werden können.
- Jeder, der die Adresse kennt, kann jedem Raum beitreten. Für einen geschlossenen Kreis den Zugriff über den Reverse-Proxy oder eine Firewall einschränken.
- Privatnachrichten werden nicht gespeichert und sind nach dem Neuladen der Seite weg.
- Der Verlauf liegt als JSON-Datei in `DATA_DIR/state.json`, Bilder in `DATA_DIR/uploads`. Für ein Backup genügt eine Kopie dieses Ordners.

## Aufbau

```
server.js            Einstiegspunkt
src/config.js        Einstellungen aus Umgebungsvariablen
src/store.js         Speicherung des Verlaufs
src/app.js           HTTP- und WebSocket-Server
public/              Web-Oberfläche (HTML, CSS, JavaScript ohne Build-Schritt)
test/                Automatische Tests
deploy/              systemd-Dienst
```
