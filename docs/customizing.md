# Customizing the bot

The bot is plain Node.js with no build step and only three dependencies. You can change anything with a text editor. This page explains how the code fits together and walks through the most common changes.

- [How it works](#how-it-works)
- [Making changes and applying them](#making-changes-and-applying-them)
- [Recipes](#recipes)
  - [Add a chat command](#add-a-chat-command)
  - [Only let certain people control the bot](#only-let-certain-people-control-the-bot)
  - [Search SoundCloud instead of YouTube](#search-soundcloud-instead-of-youtube)
  - [Add radio station shortcuts (a new source)](#add-radio-station-shortcuts-a-new-source)
  - [Even out loudness between songs](#even-out-loudness-between-songs)
  - [Change the "Now playing" message](#change-the-now-playing-message)
  - [Restyle the web UI](#restyle-the-web-ui)
  - [Control the bot from scripts (HTTP API)](#control-the-bot-from-scripts-http-api)
- [Keeping your changes when you update](#keeping-your-changes-when-you-update)

---

## How it works

```
 chat command / web UI
          │
          ▼
  sources.js  resolve()   ── turns a link or search into queue entries
          │
          ▼
  queue.js    MusicManager ── keeps the queue, downloads the next few songs ahead (yt-dlp or a direct download)
          │
          ▼
  player.js   Player       ── ffmpeg turns the file into Opus audio, sent in 20 ms frames
          │
          ▼
  ts.js       TeamSpeakBot ── the TeamSpeak connection: voice, chat, reconnects
```

| File | What it does |
|---|---|
| `src/index.js` | Starts everything and connects the parts. Also sends the "Now playing" channel messages. |
| `src/config.js` | Reads `.env` and holds every setting with its default. |
| `src/ts.js` | Connects to TeamSpeak, reconnects, walks back after a channel kick, sends chat messages and voice. |
| `src/commands.js` | All `/` chat commands, their help texts and aliases. |
| `src/sources.js` | Recognizes YouTube, Spotify, direct links and searches, runs the search providers, and downloads songs. |
| `src/search.js` | Keeps search results for 30 minutes so they can be picked later (`/pick`, the web UI's search panel). |
| `src/queue.js` | The queue: adding, reordering, prefetching, deleting files after playing, saving to `data/state.json`. |
| `src/player.js` | Runs ffmpeg and sends the audio in real time. Handles volume, pause, seek and resuming after a reconnect. |
| `src/ogg.js` | Splits ffmpeg's Ogg output into single Opus packets. |
| `src/web.js` | The web server: login, live updates, the HTTP API, uploads. |
| `public/` | The web UI: `index.html`, `app.js`, `style.css`, `login.html`. These files are served as they are. |

A queue entry is a plain object. Sources create entries like these:

```js
{ title: 'Artist - Song', source: 'youtube', input: '<what yt-dlp downloads>', url: '<link shown to users>' }
{ title: 'Song', source: 'url', input: 'https://…/song.mp3', url: '…', direct: true }   // downloaded without yt-dlp
{ title: 'Radio', source: 'url', input: '…', url: '…', streamUrl: '…', isLive: true }    // streamed live, never downloaded
```

The queue adds `id`, `status` (`pending` → `downloading` → `ready`, or `error`), `file`, `addedBy` and so on.

---

## Making changes and applying them

**Docker:** the code is copied into the image, so rebuild after every change:

```bash
docker compose up -d --build && docker compose logs -f
```

**systemd install:** edit the files in `/opt/tsmb`, then run:

```bash
sudo systemctl restart tsmb
```

**While developing on your own machine** (you need Node.js 20+, ffmpeg and yt-dlp):

```bash
npm install
```
```bash
node --watch src/index.js
```

`--watch` restarts the bot every time you save a file in `src/`. Changes in `public/` only need a browser refresh.

If something breaks, the log tells you where. A typo in a file stops the bot at startup with the file name and line number. Errors inside a command are sent back to the chat as `Error: …`.

---

## Recipes

### Add a chat command

Commands live in the `commands` object in `src/commands.js`. Each one is an `async` function. It gets the text after the command (`args`) and the chat message (`msg`), and it returns the reply. Return `null` to send no reply.

Example: `/uptime` replies with how long the bot has been running.

```js
// src/commands.js, inside `const commands = { ... }`
    async uptime() {
      return `Running for ${fmtTime(process.uptime())}.`;
    },
```

Add it to the `HELP` list at the top of the file so it shows up in `/help`:

```js
  ['uptime', 'show how long the bot has been running'],
```

To give it a short alias like `/up`, add `up: 'uptime'` to `aliases`. Here `/up` is already taken by "move song up", so pick another name. An alias always wins over a command with the same name.

Inside a command you can use:
- `music`: the queue. For example `music.add(input, { addedBy })`, `music.skip()`, `music.state()`, `music.player.volume`.
- `ts`: TeamSpeak. For example `ts.reply(msg, text)`, `ts.channelOf(clientId)`, `ts.moveTo(channelId)`.
- `msg.invokerName`, `msg.invokerUID` (the user's unique ID), `msg.invokerGroups` (server group IDs), `msg.invokerID`.

Replies can use TeamSpeak BBCode: `[b]bold[/b]`, `[i]italic[/i]`, `[color=red]…[/color]`, `[url=https://…]text[/url]`. Wrap titles in `esc()` so a song name with `[` or `]` in it can't break the formatting.

### Only let certain people control the bot

Everyone can use every command by default. To limit commands like `/stop` and `/clear` to certain server groups, add a check in `onText` near the bottom of `src/commands.js`, right after the line that looks up `fn`:

```js
    const fn = commands[cmd];
    if (!fn) return ts.reply(msg, `Unknown command. Type ${P}help for a list.`);

    // only these server groups may use these commands (see the group IDs in your TeamSpeak server's permissions)
    const ADMIN_GROUPS = ['6', '9'];
    const ADMIN_ONLY = ['stop', 'clear', 'shuffle', 'vol', 'join'];
    if (ADMIN_ONLY.includes(cmd) && !msg.invokerGroups.some((g) => ADMIN_GROUPS.includes(String(g)))) {
      return ts.reply(msg, 'Sorry, only admins can do that.');
    }
```

To allow specific people instead of groups, compare `msg.invokerUID` with a list of unique IDs. You can find someone's unique ID in TeamSpeak by right-clicking them and choosing **Copy unique ID**, or in their client info.

This only covers the chat. Anyone with the web password can still do everything in the web UI.

### Search SoundCloud instead of YouTube

Plain search words go to YouTube through yt-dlp's `ytsearch1:` (first result). yt-dlp supports other sites too. In `resolve()` in `src/sources.js`:

```js
  if (source === 'search') {
    return [{ title: input, source: 'search', input: `scsearch1:${input}`, url: null }];   // was ytsearch1:
  }
```

The search panel and `/search` use `searchYoutube()` in the same file. Change `ytsearch${limit}:` there to `scsearch${limit}:`, and the badge `source: 'youtube'` if you like. You can also add a whole new search provider. Add it to `searchProviders()`, which controls the tabs in the web UI and the `/search <alias> words` prefixes. Then handle its `id` in `search()`, returning queue entries like the other providers do.

Spotify links are played by searching YouTube for each track. That's the `ytsearch1:${title} audio` line in `resolveSpotify()`, and you can change it the same way.

Links from SoundCloud, Bandcamp, Vimeo and [many other sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) already work without any changes. Any link that isn't a direct audio file goes through yt-dlp.

### Add radio station shortcuts (a new source)

Every source follows the same pattern. `detectSource()` recognizes the input, and `resolve()` returns queue entries. This example adds `/play radio: lofi` for a few internet radio stations you choose.

In `src/sources.js`, add the station list and recognize `radio:` first in `detectSource()`:

```js
const RADIO = {
  lofi: { title: 'Lofi Radio', url: 'https://example.com/lofi.mp3' },
  jazz: { title: 'Jazz Radio', url: 'https://example.com/jazz.aac' },
};

export function detectSource(input) {
  if (/^radio:/i.test(input)) return 'radio';
  // ...the existing checks
```

Then handle it in `resolve()`, next to the Spotify line:

```js
  if (source === 'radio') {
    const name = input.slice(6).trim().toLowerCase();
    const st = RADIO[name];
    if (!st) throw new Error(`Unknown station. Try: ${Object.keys(RADIO).join(', ')}`);
    return [{ title: st.title, source: 'url', input: st.url, url: st.url, streamUrl: st.url, isLive: true }];
  }
```

A `streamUrl` entry is ready to play at once and never downloaded. ffmpeg streams it directly and reconnects if the stream drops. For a source that should be downloaded first, leave out `streamUrl`. Then give an `input` that yt-dlp understands, or set `direct: true` to download `input` with a plain HTTP request.

To give a new source its own badge in the web UI, use your own `source` name (for example `source: 'radio'`). Add a label to `SRC_LABEL` in `public/app.js` and a color in `public/style.css`:

```css
.badge.src-radio { color: #ffb547; border-color: #5a4320; }
```

### Even out loudness between songs

The audio goes through one ffmpeg command in `#start()` in `src/player.js`. The `-af` option is the audio filter chain. To bring quiet and loud songs to a similar level, add ffmpeg's `loudnorm` filter in front of the volume:

```js
      '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,volume=${(this.volume / 100) ** 2 * 2}`,
```

Other ffmpeg filters work the same way, separated by commas. For example, `bass=g=5` boosts the bass and `atempo=1.25` plays faster. `loudnorm` takes a bit more CPU and adds a few seconds of delay when a song starts or you seek, because it looks ahead to measure the loudness.

The opus bitrate is set by `AUDIO_BITRATE` in `.env`. That needs no code change.

### Change the "Now playing" message

It's sent in `src/index.js`:

```js
music.on('nowPlaying', (item) => {
  if (!ANNOUNCE) return;
  const link = item.url ? ` - [url=${item.url}]link[/url]` : '';
  channelMsg(`Now playing: [b]${item.title.replace(/[[\]]/g, '')}[/b]${link}`);
});
```

`item` is the queue entry, with fields like `title`, `url`, `duration`, `addedBy` and `source`. For example, to show who added the song:

```js
  channelMsg(`♪ [b]${item.title.replace(/[[\]]/g, '')}[/b] (added by ${item.addedBy})${link}`);
```

To turn the message off without touching code, set `ANNOUNCE_SONGS=false` in `.env`.

### Restyle the web UI

The web UI is plain HTML, CSS and JavaScript in `public/`, with no framework and no build step. The colors are variables at the top of `public/style.css`:

```css
:root {
  --bg: #0e0f14;       /* page background */
  --card: #1a1d28;     /* panels */
  --accent: #7c5cff;   /* buttons, progress bar */
  --accent2: #2ad1a3;
  ...
}
```

Change them and refresh the page. The page title and texts are in `public/index.html`, and the login page is `public/login.html`.

`public/app.js` draws the queue from the state the server sends (`render()`), and calls the HTTP API below for every button.

### Control the bot from scripts (HTTP API)

The web UI uses a small JSON API, and you can use it too, from a script, a Stream Deck or a Discord bot. Log in once and keep the cookie:

```bash
curl -c cookies.txt -H 'Content-Type: application/json' -d '{"password":"your-web-password"}' https://music.example.com/api/login
```
```bash
curl -b cookies.txt -H 'Content-Type: application/json' -d '{"input":"never gonna give you up"}' https://music.example.com/api/add
```

| Method and path | Body | What it does |
|---|---|---|
| `GET /api/state` | | Current song, queue, volume and connection status |
| `GET /api/events` | | The same state as a live stream (Server-Sent Events) |
| `POST /api/add` | `{"input": "...", "next": false}` | Add a link or search (plays the first result) |
| `GET /api/search/providers` | | The sites you can search, e.g. `[{"id":"youtube","label":"YouTube"}]` |
| `GET /api/search?q=...&provider=youtube` | | Up to 10 results, each with an `id` |
| `POST /api/search/add` | `{"id": "...", "next": false}` | Add a search result (ids are kept for 30 minutes) |
| `POST /api/upload` | form field `files` | Upload audio files (`?next=1` to play next) |
| `POST /api/control/<action>` | | `pause`, `resume`, `toggle`, `skip`, `stop`, `shuffle`, `clear` |
| `POST /api/volume` | `{"volume": 40}` | Set the volume (0–100) |
| `POST /api/seek` | `{"seconds": 90}` | Jump in the current song |
| `POST /api/queue/<id>/up`, `/down`, `/top` | | Move a song |
| `POST /api/queue/<id>/move` | `{"to": 0}` | Move a song to a position (0 = next) |
| `DELETE /api/queue/<id>` | | Remove a song |

Song IDs come from `/api/state`. Requests that change something are refused when they come from another website (`Origin` check), so call the API from a script or server, not from someone else's web page.

To add your own endpoint, follow the pattern in `src/web.js`. Everything registered after the login check needs a valid session automatically:

```js
  app.post('/api/announce', json, wrap(async (req) => {
    await music.ts.send(2, music.ts.client.channelID(), String(req.body?.text || ''));
  }));
```

---

## Keeping your changes when you update

The easiest way is to **fork** this repository on GitHub and commit your changes to your fork. To get new versions later:

```bash
git remote add upstream https://github.com/xSMDx/Team-Speak-Music-bot.git
```
```bash
git pull upstream main
```

Git merges the updates into your changes. If it reports a conflict in a file you edited, open that file, keep the parts you want between the `<<<<<<<` and `>>>>>>>` markers, then `git add` the file and `git commit`.

Keep your settings in `.env` rather than in the code. `.env` and `data/` are never part of the repository, so updates can't overwrite them.
