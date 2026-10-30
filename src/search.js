import crypto from 'node:crypto';
import { search, searchProviders } from './sources.js';

// Search results are kept for a while so people can pick one later
// (with /pick in the chat, or by clicking it in the web UI).
const KEEP_MS = 30 * 60_000;
const MAX_KEPT = 2000;
const results = new Map(); // id -> { entry, expires }

export { searchProviders };

/** Finds the provider for an id or alias like "yt" / "sp". Without one, the first provider is used. */
export function findProvider(name) {
  const all = searchProviders();
  if (!name) return all[0];
  const n = String(name).toLowerCase();
  return all.find((p) => p.id === n || p.aliases?.includes(n)) || null;
}

/** Searches and returns the results with ids that can be passed to getResult(). */
export async function findSongs(query, providerName) {
  const provider = findProvider(providerName);
  if (!provider) throw new Error(`Unknown search provider "${providerName}"`);
  const entries = await search(provider.id, query);
  prune();
  return {
    provider,
    results: entries.map((entry) => {
      const id = crypto.randomBytes(6).toString('hex');
      results.set(id, { entry, expires: Date.now() + KEEP_MS });
      return { id, title: entry.title, artist: entry.artist || '', duration: entry.duration || 0, thumbnail: entry.thumbnail || null, source: entry.source, url: entry.url || null };
    }),
  };
}

/** The queue entry behind a search result, or null if it expired. */
export function getResult(id) {
  const r = results.get(id);
  if (!r || r.expires < Date.now()) return null;
  const { artist, ...entry } = r.entry;
  return entry;
}

function prune() {
  const now = Date.now();
  for (const [id, r] of results) if (r.expires < now) results.delete(id);
  // oldest first, so this drops the oldest results when there are too many
  for (const id of results.keys()) {
    if (results.size <= MAX_KEPT) break;
    results.delete(id);
  }
}
