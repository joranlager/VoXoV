# VoXoV

Two-way intercom for Sonos speakers. Your browser's microphone is streamed to
the speakers you pick, and a second device in the room can send its microphone
back to you.

VoXoV has two parts that run as separate processes:

| Part | What it does | Runs where |
|---|---|---|
| **Server** (`server.js`) | Finds Sonos speakers on your network, controls them, serves the live audio stream the speakers play, and relays audio between browsers. | On a computer on the same network as the speakers. |
| **Web page** (`public/index.html`) | The user interface: pick speakers, start the intercom, use a room mic. | Served by the server, or on its own (`npm run ui`, or GitHub Pages). |

Sonos has no API for its own microphones, so the return path comes from a
phone or laptop in the room that opens the page in **Room mic** mode.

## Requirements

- **Node.js 18 or newer** (tested with Node 24).
- **npm** (comes with Node).
- **Sonos speakers** on the same local network as the computer running the server.
- **ffmpeg** (optional). It is only needed for the **MP3 radio** stream option.
  Without it, the server offers WAV only.
- A modern browser: Chrome, Edge or Firefox. Safari blocks some of the
  connections the Pages version needs.

## Install

```bash
npm install
```

## Start the processes

### 1. The server (always required)

```bash
npm start
```

This starts two listeners:

- `http://localhost:8090`: the web page, the API, and the stream the speakers
  play. Speakers connect to this port over plain HTTP.
- `https://<your-LAN-IP>:8443`: HTTPS, required for other devices (room mics)
  to use their microphone. The server prints the exact addresses at startup.

On first start it creates a self-signed certificate in `.cert/`. Other devices
see a browser warning about it, so accept it once on each device.

### 2. The web page (optional, pick one)

**Option A: use the page served by the server.** Open http://localhost:8090.
Nothing else is needed.

**Option B: a separate page on its own port.**

```bash
npm run ui
```

Then open http://localhost:5500. This page connects to the server at
`http://localhost:8090` by default. Change the address in the **Server** box
if your server runs elsewhere.

**Option C: the GitHub Pages copy.** https://joranlager.github.io/VoXoV/
Enter the server address in the **Server** box. The server must allow the
Pages origin (see [Configuration](#configuration)), and because the page is
https while the server is plain http, the browser may ask you to allow access
to devices on your local network. Choose **Allow**.

### 3. Room mic devices (optional)

On a phone or laptop near the speaker, open one of the HTTPS addresses printed
by the server, with `#room` added:

```
https://192.168.x.x:8443/#room
```

Accept the certificate warning once, then choose **Start room microphone**.
Keep the screen on and leave the device near the speaker.

## Using the intercom

1. Press **Scan** to find speakers (or add one by IP address).
2. Tick the speakers you want to talk through.
3. Press **Start intercom**. Your voice plays on those speakers after a few
   seconds of buffering.
4. Any connected room mic is heard in the browser.
5. Press **Stop intercom** to end it. The speakers return to what they were
   playing before.

**Mute my mic** stops your microphone without ending the session.

**Stream** chooses WAV (lower delay) or MP3 radio (more compatible, needs ffmpeg).

If you close the page while the intercom is running, the server gives the
speakers back after about 15 seconds.

## Configuration

Set these environment variables before starting the server:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | HTTP port for the page, API and speaker stream. |
| `HTTPS_PORT` | `8443` | HTTPS port for room mics and the Pages version. |
| `ALLOWED_ORIGINS` | `https://joranlager.github.io` | Comma-separated list of other websites allowed to use this server. `localhost` and the server's own LAN addresses are always allowed. |
| `UI_PORT` | `5500` | Port for `npm run ui`. |

Example (PowerShell):

```powershell
$env:PORT = "8091"; npm start
```

Example (bash):

```bash
PORT=8091 npm start
```

## Security

- The server has **no login**. Anyone who can reach its port on your network can
  control the speakers, so keep it on a network you trust.
- Only the origins listed above may call the server from a browser; other
  websites are refused, including their WebSocket connections.
- `.cert/` holds the server's private TLS key. It is in `.gitignore`; never commit it.

## Troubleshooting

- **No speakers found:** make sure the computer and speakers are on the same
  network (and not a guest Wi-Fi). Use **Add** with the speaker's IP address.
- **"Cannot reach the VoXoV server":** the server isn't running, or the address
  in the Server box is wrong. Start it with `npm start`.
- **Pages version can't connect:** check that the server address is correct,
  that the browser allowed local-network access, and that you opened the
  server's HTTPS address once to accept its certificate.
- **Room mic says the browser blocks the microphone:** open the `https://` address
  printed by the server, not the `http://` one.
- **Speakers don't respond after a crash:** the server restores them when it exits
  normally (Ctrl+C). After a crash, play something on the speaker in the Sonos app.
- **MP3 option is missing:** install ffmpeg and make sure `ffmpeg` runs in a new terminal.

## Project layout

```
server.js           the server: discovery, speaker control, streams, audio relay
serve-ui.js         serves public/ on its own port (npm run ui)
public/index.html   the single-page web app
.github/workflows/  GitHub Pages deployment
.cert/              generated TLS certificate (not committed)
```
