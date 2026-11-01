import { creditText, isWantedGroup } from './importer.js';
import { INTERACTIVE, escapeLucene } from './musicbrainz.js';

const CACHE_TTL_MS = 10 * 60000;
const CACHE_MAX = 2000;
const MAX_WAITING = 20;
const RESULTS_PER_KIND = 5;
export const LIVE_KINDS = ['artist', 'album', 'song'];

const coverFor = (groupId) => `https://coverartarchive.org/release-group/${groupId}/front-250`;

// Matches the whole phrase first, then treats the last word as still being typed.
export function buildLiveQuery(field, text) {
  const words = String(text).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return null;
  const escaped = words.map(escapeLucene);
  const phrase = `${field}:"${escaped.join(' ')}"^4`;
  const partial = `${field}:(${[...escaped.slice(0, -1), `${escaped[escaped.length - 1]}*`].join(' AND ')})`;
  return `${phrase} OR ${partial}`;
}

function closestFirst(items, text) {
  const target = text.trim().toLowerCase();
  const rank = (item) => {
    const name = item.name.toLowerCase();
    if (name === target) return 0;
    if (name.startsWith(target)) return 1;
    return 2;
  };
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class LiveSearch {
  constructor(db, mb, { now = Date.now } = {}) {
    this.db = db;
    this.mb = mb;
    this.now = now;
    this.cache = new Map();
  }

  remember(key, items) {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { items, at: this.now() });
  }

  localId(table, mbid) {
    return this.db.prepare(`SELECT id FROM ${table} WHERE mbid = ?`).get(mbid)?.id;
  }

  // Music already on the site links straight to its page. Anything else is added when opened.
  linkArtist(mbid) {
    const id = this.localId('artists', mbid);
    return id ? `/artists/${id}` : `/open/artist/${mbid}`;
  }

  linkAlbum(mbid) {
    const id = this.localId('albums', mbid);
    return id ? `/albums/${id}` : `/open/album/${mbid}`;
  }

  linkSong(mbid, groupId) {
    const row = this.db.prepare(`SELECT songs.id FROM songs JOIN albums ON albums.id = songs.album_id
      WHERE songs.mbid = ? AND albums.mbid = ?`).get(mbid, groupId);
    return row ? `/songs/${row.id}` : `/open/song/${mbid}/${groupId}`;
  }

  async fetchRaw(kind, text, options) {
    if (kind === 'artist') {
      const { artists = [] } = await this.mb.searchArtists(buildLiveQuery('artist', text), RESULTS_PER_KIND * 2, options);
      return artists.map((artist) => ({
        kind,
        mbid: artist.id,
        name: artist.name,
        context: `${artist.type === 'Person' ? 'Artist' : artist.type || 'Artist'}${artist.disambiguation ? `, ${artist.disambiguation}` : (artist.country ? `, ${artist.country}` : '')}`,
      }));
    }
    if (kind === 'album') {
      const { 'release-groups': groups = [] } = await this.mb.searchReleaseGroups(buildLiveQuery('releasegroup', text), { limit: RESULTS_PER_KIND * 3, ...options });
      return uniqueBy(groups.filter(isWantedGroup).map((group) => ({
        kind,
        mbid: group.id,
        name: group.title,
        context: `${group['primary-type']} by ${creditText(group['artist-credit'])}`,
        cover: coverFor(group.id),
      })), (item) => `${item.name}|${item.context}`.toLowerCase());
    }
    const { recordings = [] } = await this.mb.searchRecordings(buildLiveQuery('recording', text), RESULTS_PER_KIND * 3, options);
    const songs = [];
    for (const recording of recordings) {
      const releases = recording.releases || [];
      const groups = releases.map((release) => release['release-group']).filter(Boolean);
      const group = groups.find(isWantedGroup) || groups[0];
      if (group) {
        songs.push({
          kind,
          mbid: recording.id,
          groupId: group.id,
          name: recording.title,
          context: `Song by ${creditText(recording['artist-credit'])}`,
          cover: coverFor(group.id),
        });
      }
    }
    return uniqueBy(songs, (item) => `${item.name}|${item.context}`.toLowerCase());
  }

  // Returns [] for a query too short to search, or when too many people are already waiting.
  async search(kind, text, { signal } = {}) {
    const clean = String(text).trim().slice(0, 120);
    if (clean.length < 2 || !LIVE_KINDS.includes(kind)) return [];
    const key = `${kind}:${clean.toLowerCase()}`;
    const cached = this.cache.get(key);
    let raw;
    if (cached && this.now() - cached.at < CACHE_TTL_MS) {
      raw = cached.items;
    } else {
      if (this.mb.interactiveWaiting >= MAX_WAITING) return [];
      raw = closestFirst(await this.fetchRaw(kind, clean, { ...INTERACTIVE, signal }), clean).slice(0, RESULTS_PER_KIND);
      this.remember(key, raw);
    }
    // Links are worked out on each request, since a result may have been added since it was cached.
    return raw.map((item) => ({
      kind: item.kind,
      name: item.name,
      context: item.context,
      cover: item.cover || null,
      url: {
        artist: () => this.linkArtist(item.mbid),
        album: () => this.linkAlbum(item.mbid),
        song: () => this.linkSong(item.mbid, item.groupId),
      }[item.kind](),
    }));
  }
}
