# TSMB – TeamSpeak Music Bot

A TeamSpeak 3 music bot with a password-protected web UI.

- Plays **YouTube** links, playlists and search, **Spotify** tracks, albums and playlists, **direct links** (mp3 files, internet radio) and **uploaded files** (several at once)
- **Queue**: drag and drop or ▲ ▼ ⤒ buttons to reorder, remove, shuffle, clear
- **Songs delete themselves** after they're played, skipped or removed
- **Reconnects automatically** after a disconnect, a server restart, a kick or a network drop, and resumes the song where it stopped. If someone kicks it from its channel, it walks back.
- **`/` chat commands** in TeamSpeak (channel chat or private message)
- The queue survives restarts. Pure Node.js, with no TeamSpeak client or GUI needed.

---

## 1. Point a subdomain at your server

This guide uses `music.example.com`. Replace it with your own (sub)domain everywhere below. At your DNS provider, add:

| Type | Name   | Value               |
|------|--------|---------------------|
| A    | `music` | your server's IP   |

Anything else already running on your main domain isn't affected. nginx sends requests to the right app based on the hostname.

## 2. Configure

```bash
cp .env.example .env
nano .env
```

At minimum, set these:

```ini
TS_HOST=127.0.0.1            # or your TeamSpeak server's address
TS_CHANNEL=Music             # channel to join (optional)
WEB_PASSWORD=something-long  # password for the web UI
PUBLIC_URL=https://music.example.com  # your domain (used in the /web link)
```

## 3. Start the bot

**With Docker (recommended):**

```bash
docker compose up -d --build
docker compose logs -f
```

**Without Docker (Debian/Ubuntu, systemd):**

```bash
sudo ./install.sh
sudo nano /opt/tsmb/.env
sudo systemctl restart tsmb
journalctl -u tsmb -f
```

The web UI listens only on `127.0.0.1:8090`, so it can't be reached directly by IP. It's only available through the domain.

## 4. Publish it on your domain (nginx + HTTPS)

First, edit `server_name` in `deploy/nginx.conf` to your domain. Then:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tsmb
sudo ln -s /etc/nginx/sites-available/tsmb /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d music.example.com
```

Open https://music.example.com and log in with `WEB_PASSWORD`.

**Using a different proxy?**
- **Caddy**: `music.example.com { reverse_proxy 127.0.0.1:8090 }`
- **Nginx Proxy Manager / a proxy inside Docker**: set `WEB_HOST=0.0.0.0` in `.env`, then add a proxy host `music.example.com → <server-ip>:8090`. Block port 8090 in your firewall so it can't be opened by IP.
- **Cloudflare** (proxied DNS or Cloudflare Tunnel): see [docs/cloudflare.md](docs/cloudflare.md) for the SSL mode, real visitor IPs, upload limits and troubleshooting.

---

## Chat commands

| Command | What it does |
|---|---|
| `/play <link or search>` (`/p`) | Add a YouTube, Spotify or direct link, or search YouTube |
| `/playnext <link>` (`/pn`) | Add to the front of the queue |
| `/pause`, `/resume` | Pause or continue |
| `/skip` (`/s`) | Skip the current song |
| `/stop` | Stop and clear the queue |
| `/np` | Show what's playing |
| `/queue [page]` (`/q`) | Show the queue |
| `/remove <n>` | Remove song #n |
| `/move <from> <to>` | Move a song |
| `/up <n>`, `/down <n>`, `/top <n>` | Move song #n up, down or to the top |
| `/shuffle`, `/clear` | Shuffle or empty the queue |
| `/vol <0-100>` | Volume |
| `/seek <m:ss>` | Jump to a time |
| `/join` | Bring the bot to your channel |
| `/web` | Link to the web UI |
| `/help` | List the commands |

The bot reads the chat of the channel it's in, and private messages sent to it.

## Customizing

Want your own commands, a different search site, admin-only commands, radio shortcuts or a new look? [docs/customizing.md](docs/customizing.md) explains how the code fits together and has step-by-step recipes.

## Troubleshooting

- **YouTube says "Sign in to confirm you're not a bot"**: YouTube sometimes blocks server IPs. Export your YouTube cookies (browser extension "Get cookies.txt LOCALLY") to `data/cookies.txt` and restart.
- **Bot is silent in a moderated channel**: give it talk power, or put it in a server group that has `i_client_talk_power`.
- **"client could not validate identity"**: the server needs a higher security level. Set `TS_IDENTITY_LEVEL`, delete `data/identity.txt` and restart.
- **Spotify**: Spotify's audio is DRM-protected, so each track is looked up and played from YouTube. If Spotify links fail, add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` (free at developer.spotify.com).
- **Forgot the web password**: change `WEB_PASSWORD` in `.env` and restart.
- yt-dlp updates itself every time the bot starts, so YouTube changes don't break it.

## Files

`data/` holds the bot's identity, the queue state, login sessions and temporary song files (they're deleted after playing). Back up `data/identity.txt` to keep the same TeamSpeak identity.
