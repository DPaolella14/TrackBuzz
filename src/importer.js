import { readFileSync } from 'node:fs';
import { transaction } from './db.js';
import { ensureGenre } from './catalog.js';
import { escapeLucene } from './musicbrainz.js';

const ALLOWED_TYPES = new Set(['Album', 'EP', 'Single']);
const SKIPPED_SECONDARY_TYPES = new Set(['Compilation', 'DJ-mix', 'Mixtape/Street', 'Audiobook', 'Audio drama', 'Spokenword', 'Interview', 'Demo', 'Field recording']);
const SEARCH_MATCH_SCORE = 90;
const ARTIST_ALBUM_LIMIT = 40;
const REFRESH_OVERLAP_DAYS = 7;

export function creditText(credits) {
  return (credits || []).map((part) => `${part.name ?? part.artist?.name ?? ''}${part.joinphrase ?? ''}`).join('').trim();
}

export function chooseRelease(releases) {
  const usable = (releases || []).filter((release) => (release.media || []).some((medium) => (medium.tracks || []).length));
  return usable.sort((a, b) => {
    const dateA = a.date || '9999';
    const dateB = b.date || '9999';
    return dateA.localeCompare(dateB) || (b['track-count'] ?? 0) - (a['track-count'] ?? 0);
  })[0] || null;
}

export function isWantedGroup(group) {
  return ALLOWED_TYPES.has(group['primary-type'])
    && !(group['secondary-types'] || []).some((type) => SKIPPED_SECONDARY_TYPES.has(type));
}

function yearOf(date) {
  const year = Number(String(date || '').slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

function linkGenres(db, table, column, id, genres) {
  const sorted = [...(genres || [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 6);
  const link = db.prepare(`INSERT OR IGNORE INTO ${table} (${column}, genre_id) VALUES (?, ?)`);
  for (const genre of sorted) {
    const genreId = ensureGenre(db, genre.name || '');
    if (genreId) link.run(id, genreId);
  }
}

export class Importer {
  constructor(db, mb, { log = () => {} } = {}) {
    this.db = db;
    this.mb = mb;
    this.log = log;
  }

  albumExists(mbid) {
    return Boolean(this.db.prepare('SELECT 1 FROM albums WHERE mbid = ?').get(mbid));
  }

  async ensureArtist(artist, options) {
    const existing = this.db.prepare('SELECT id FROM artists WHERE mbid = ?').get(artist.id);
    if (existing) return existing.id;
    const full = await this.mb.lookupArtist(artist.id, options);
    return transaction(this.db, () => {
      // Someone else may have added this artist during the lookup.
      const added = this.db.prepare('SELECT id FROM artists WHERE mbid = ?').get(artist.id);
      if (added) return added.id;
      const id = Number(this.db.prepare(`INSERT INTO artists (mbid, name, country, artist_type, begin_year) VALUES (?, ?, ?, ?, ?)`)
        .run(full.id, full.name, full.country ?? null, full.type ?? null, yearOf(full['life-span']?.begin)).lastInsertRowid);
      linkGenres(this.db, 'artist_genres', 'artist_id', id, full.genres);
      return id;
    });
  }

  // Returns true when a new album was stored. With force, a person asked for this exact release,
  // so it's stored even if it's a type the automatic imports skip.
  async importReleaseGroup(mbid, { force = false, ...options } = {}) {
    if (this.albumExists(mbid)) return false;
    const group = await this.mb.lookupReleaseGroup(mbid, options);
    if (!force && !isWantedGroup(group)) return false;
    const { releases } = await this.mb.browseReleases(mbid, options);
    const release = chooseRelease(releases);
    const credit = group['artist-credit']?.[0]?.artist;
    if (!release || !credit) return false;
    const artistId = await this.ensureArtist(credit, options);
    const albumCredit = creditText(group['artist-credit']);
    return transaction(this.db, () => {
      if (this.albumExists(mbid)) return false;
      const albumId = Number(this.db.prepare(`INSERT INTO albums (mbid, title, artist_id, artist_credit, release_date, album_type, cover_url) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(group.id, group.title, artistId, albumCredit, group['first-release-date'] || release.date || null, group['primary-type'],
          `https://coverartarchive.org/release-group/${group.id}/front-250`).lastInsertRowid);
      linkGenres(this.db, 'album_genres', 'album_id', albumId, group.genres);
      const insertSong = this.db.prepare(`INSERT OR IGNORE INTO songs (mbid, title, album_id, artist_id, artist_credit, disc, position, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [mediumIndex, medium] of (release.media || []).entries()) {
        for (const [trackIndex, track] of (medium.tracks || []).entries()) {
          const recording = track.recording || {};
          const songCredit = creditText(track['artist-credit'] || recording['artist-credit']) || albumCredit;
          insertSong.run(recording.id ?? null, track.title || recording.title, albumId, artistId, songCredit,
            medium.position ?? mediumIndex + 1, track.position ?? trackIndex + 1, track.length ?? recording.length ?? null);
        }
      }
      return true;
    });
  }

  async importArtistByName(name) {
    const { artists = [] } = await this.mb.searchArtists(`artist:"${escapeLucene(name)}"`, 1);
    const match = artists[0];
    if (!match || (match.score ?? 0) < SEARCH_MATCH_SCORE) return 0;
    return this.importArtistById(match.id, match);
  }

  async importArtistById(mbid, artist = { id: mbid }) {
    await this.ensureArtist(artist);
    let added = 0;
    const { 'release-groups': groups = [] } = await this.mb.browseArtistReleaseGroups(mbid);
    const wanted = groups.filter(isWantedGroup).sort((a, b) => Number(b['primary-type'] === 'Album') - Number(a['primary-type'] === 'Album')
      || String(b['first-release-date'] || '').localeCompare(String(a['first-release-date'] || '')));
    for (const group of wanted.slice(0, ARTIST_ALBUM_LIMIT)) {
      if (await this.importReleaseGroup(group.id)) added += 1;
    }
    return added;
  }

  // Handles a search with no local answer: the words might be an artist, an album, or a song.
  async importSearchTerm(term) {
    let added = await this.importArtistByName(term);
    const escaped = escapeLucene(term);
    const { 'release-groups': groups = [] } = await this.mb.searchReleaseGroups(`releasegroup:"${escaped}"`, { limit: 5 });
    for (const group of groups) {
      if ((group.score ?? 0) >= SEARCH_MATCH_SCORE && await this.importReleaseGroup(group.id)) added += 1;
    }
    const { recordings = [] } = await this.mb.searchRecordings(`recording:"${escaped}"`, 5);
    for (const recording of recordings) {
      const groupId = recording.releases?.[0]?.['release-group']?.id;
      if ((recording.score ?? 0) >= SEARCH_MATCH_SCORE && groupId && await this.importReleaseGroup(groupId)) added += 1;
    }
    return added;
  }

  async syncNewReleases({ maxNew = 200, now = new Date() } = {}) {
    const last = this.db.prepare(`SELECT max(started_at) AS at FROM sync_runs WHERE status = 'done'`).get().at;
    // Releases are often entered a few days late, so each run looks back over recent days too.
    const from = new Date((last ? Date.parse(`${last}Z`) : now.getTime()) - REFRESH_OVERLAP_DAYS * 86400000);
    const dateRange = `[${from.toISOString().slice(0, 10)} TO ${now.toISOString().slice(0, 10)}]`;
    const queries = [
      `firstreleasedate:${dateRange} AND status:official AND (primarytype:album OR primarytype:ep)`,
      `firstreleasedate:${dateRange} AND status:official AND primarytype:single`,
    ];
    let added = 0;
    for (const query of queries) {
      for (let offset = 0; added < maxNew;) {
        const { 'release-groups': groups = [], count = 0 } = await this.mb.searchReleaseGroups(query, { limit: 100, offset });
        if (!groups.length) break;
        for (const group of groups) {
          if (added >= maxNew) break;
          try {
            if (await this.importReleaseGroup(group.id)) added += 1;
          } catch (err) {
            // One bad release shouldn't stop the rest of the run.
            this.log(`Skipped release group ${group.id}: ${err.message}`);
          }
        }
        offset += groups.length;
        if (offset >= count) break;
      }
    }
    return added;
  }

  async runSync(options) {
    const runId = Number(this.db.prepare('INSERT INTO sync_runs DEFAULT VALUES').run().lastInsertRowid);
    try {
      const added = await this.syncNewReleases(options);
      this.db.prepare(`UPDATE sync_runs SET status = 'done', finished_at = datetime('now'), albums_added = ? WHERE id = ?`).run(added, runId);
      return added;
    } catch (err) {
      this.db.prepare(`UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?`).run(err.message, runId);
      throw err;
    }
  }
}

export function enqueueImport(db, kind, term) {
  const clean = String(term).trim().slice(0, 120);
  if (!clean) return;
  db.prepare('INSERT OR IGNORE INTO import_queue (kind, term, term_key) VALUES (?, ?, ?)').run(kind, clean, clean.toLowerCase());
}

export function importStatus(db, term) {
  const row = db.prepare(`SELECT status FROM import_queue WHERE kind = 'search' AND term_key = ?`).get(String(term).trim().toLowerCase());
  return row?.status ?? null;
}

export function artistImportPending(db, mbid) {
  return Boolean(mbid && db.prepare(`SELECT 1 FROM import_queue WHERE kind = 'artist_id' AND term_key = ? AND status = 'pending'`).get(mbid.toLowerCase()));
}

export function libraryLoading(db) {
  return Boolean(db.prepare(`SELECT 1 FROM import_queue WHERE status = 'pending' LIMIT 1`).get());
}

export function enqueueStarterCatalog(db) {
  if (db.prepare('SELECT 1 FROM artists LIMIT 1').get() || db.prepare('SELECT 1 FROM import_queue LIMIT 1').get()) return 0;
  const names = readFileSync(new URL('../catalog/starter-artists.txt', import.meta.url), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const name of names) enqueueImport(db, 'artist', name);
  return names.length;
}

export async function processNextImport(db, importer) {
  const job = db.prepare(`SELECT id, kind, term FROM import_queue WHERE status = 'pending'
    ORDER BY (kind IN ('search', 'artist_id')) DESC, id LIMIT 1`).get();
  if (!job) return false;
  try {
    if (job.kind === 'artist') await importer.importArtistByName(job.term);
    else if (job.kind === 'artist_id') await importer.importArtistById(job.term);
    else await importer.importSearchTerm(job.term);
    db.prepare(`UPDATE import_queue SET status = 'done', finished_at = datetime('now') WHERE id = ?`).run(job.id);
  } catch (err) {
    db.prepare(`UPDATE import_queue SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`).run(err.message, job.id);
  }
  return true;
}

// Runs inside the web server so all MusicBrainz calls share one rate limit.
export function startCatalogWorker(db, importer, { syncEveryHours, maxNew, log = console.log }) {
  let stopped = false;
  let timer;
  const syncDue = () => {
    const { done, attempted } = db.prepare(`SELECT max(CASE WHEN status = 'done' THEN started_at END) AS done, max(started_at) AS attempted FROM sync_runs`).get();
    const hoursSince = (at) => (Date.now() - Date.parse(`${at}Z`)) / 3600000;
    return !attempted || (hoursSince(attempted) >= 1 && (!done || hoursSince(done) >= syncEveryHours));
  };
  const tick = async () => {
    try {
      const worked = await processNextImport(db, importer);
      if (!worked && syncDue()) {
        const added = await importer.runSync({ maxNew });
        log(`Catalog sync added ${added} new releases.`);
      }
      if (!stopped) timer = setTimeout(tick, worked ? 100 : 15000);
    } catch (err) {
      log(`Catalog sync failed: ${err.message}`);
      if (!stopped) timer = setTimeout(tick, 15 * 60000);
    }
  };
  db.prepare(`UPDATE sync_runs SET status = 'failed', error = 'Interrupted by a restart', finished_at = datetime('now') WHERE status = 'running'`).run();
  enqueueStarterCatalog(db);
  timer = setTimeout(tick, 2000);
  return () => { stopped = true; clearTimeout(timer); };
}
