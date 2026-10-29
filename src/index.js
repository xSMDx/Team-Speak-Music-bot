import { config } from './config.js';
import { TeamSpeakBot } from './ts.js';
import { Player } from './player.js';
import { MusicManager } from './queue.js';
import { createCommandHandler } from './commands.js';
import { startWeb } from './web.js';

// A bad packet or library hiccup must never take the bot down
process.on('uncaughtException', (e) => console.error('[fatal?] uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('[fatal?] unhandled rejection:', e));

const ts = new TeamSpeakBot();
const player = new Player(ts);
const music = new MusicManager(ts, player);
const onText = createCommandHandler(ts, music);

ts.on('text', (msg) => onText(msg).catch((e) => console.error('[cmd]', e)));

const ANNOUNCE = !/^(0|false|no|off)$/i.test(process.env.ANNOUNCE_SONGS || 'true');
const channelMsg = (text) => ts.connected && ts.send(2, ts.client.channelID(), text);
music.on('announce', (text) => channelMsg(text));
music.on('nowPlaying', (item) => {
  if (!ANNOUNCE) return;
  const link = item.url ? ` - [url=${item.url}]link[/url]` : '';
  channelMsg(`Now playing: [b]${item.title.replace(/[[\]]/g, '')}[/b]${link}`);
});

let started = false;
ts.on('state', (s) => {
  if (s.state === 'connected' && !started) {
    started = true;
    music.startup();
  }
});

startWeb(music);
ts.start();

const shutdown = async () => {
  console.log('shutting down...');
  player.stop();
  await ts.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[bot] TeamSpeak music bot starting - server ${config.ts.host}`);
