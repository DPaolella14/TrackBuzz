// Loads the complete MusicBrainz catalog from its public data files.
//
// The work happens in a separate database. The site's database only changes in the last step, when the
// finished copy replaces it, so a failed import can't damage the site. Existing artists, albums, and songs
// keep their IDs, which keeps every post and link pointing at the right page.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { totalmem } from 'node:os';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { slugify } from './catalog.js';
import { openDb } from './db.js';

export const DOWNLOAD_HOSTS = [
  'https://data.metabrainz.org/pub/musicbrainz/data/fullexport',
  'https://ftp.musicbrainz.org/pub/musicbrainz/data/fullexport',
];
const GB = 1024 ** 3;
const SPACE_FOR_DATABASE = 25 * GB;
const MINIMUM_FREE = 2 * GB;
const BATCH = 50000;
const MAX_GENRES = 6;

export const ARCHIVES = {
  core: {
    file: 'mbdump.tar.bz2',
    tables: ['artist', 'artist_type', 'artist_credit', 'artist_credit_name', 'iso_3166_1', 'release_group',
      'release_group_primary_type', 'release', 'release_status', 'release_country', 'release_unknown_country',
      'medium', 'track', 'recording', 'genre'],
  },
  art: {
    file: 'mbdump-cover-art-archive.tar.bz2',
    tables: ['cover_art_archive.cover_art', 'cover_art_archive.cover_art_type'],
  },
  // Tags are licensed for non-commercial use, unlike the rest of the catalog.
  genres: {
    file: 'mbdump-derived.tar.bz2',
    tables: ['tag', 'artist_tag', 'release_group_tag'],
  },
};

export class ImportStopped extends Error {}

const defaultLog = (message) => console.log(`${new Date().toLocaleTimeString()}  ${message}`);

export function freeSpace(path) {
  const { bavail, bsize } = statfsSync(path);
  return bavail * bsize;
}

const formatGb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;

// Rows are in PostgreSQL's text format: tabs between columns, \N for empty, and backslash escapes.
function unescapeField(field) {
  if (field === '\\N') return null;
  if (!field.includes('\\')) return field;
  return field.replace(/\\(.)/g, (_, char) => ({ t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v' }[char] ?? char));
}

export async function* readTable(path) {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (line) yield line.split('\t').map(unescapeField);
  }
}

// A number array indexed by MusicBrainz ID that grows as larger IDs appear.
class IdMap {
  constructor(ArrayType = Int32Array, initial = 1 << 20) {
    this.ArrayType = ArrayType;
    this.data = new ArrayType(initial);
  }

  get(id) {
    return id < this.data.length ? this.data[id] : 0;
  }

  set(id, value) {
    if (id >= this.data.length) {
      const bigger = new this.ArrayType(Math.max(id + 1, Math.floor(this.data.length * 1.5)));
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[id] = value;
  }
}

const uuidToBytes = (uuid, buffer, offset) => buffer.write(uuid.replaceAll('-', ''), offset, 16, 'hex');
function bytesToUuid(buffer, offset) {
  const hex = buffer.toString('hex', offset, offset + 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeDate(year, month, day) {
  return year ? Number(year) * 10000 + Number(month || 0) * 100 + Number(day || 0) : 0;
}

function decodeDate(value) {
  if (!value) return null;
  const year = String(Math.floor(value / 10000)).padStart(4, '0');
  const month = Math.floor(value / 100) % 100;
  const day = value % 100;
  if (!month) return year;
  if (!day) return `${year}-${String(month).padStart(2, '0')}`;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Loads the catalog from a folder of data files, deleting each file once it's no longer needed.
export async function buildCatalog(db, folder, { log = defaultLog, checkSpace = () => {}, keepFiles = false } = {}) {
  const file = (name) => join(folder, name);
  const has = (name) => existsSync(file(name));
  const done = (name) => { if (!keepFiles) rmSync(file(name), { force: true }); };

  db.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -512000;
    PRAGMA temp_store = FILE; PRAGMA foreign_keys = OFF; PRAGMA locking_mode = EXCLUSIVE;`);
  db.exec(`DROP TRIGGER IF EXISTS artists_search; DROP TRIGGER IF EXISTS albums_search;
    DROP TRIGGER IF EXISTS songs_search; DROP TRIGGER IF EXISTS genres_search;
    DROP INDEX IF EXISTS songs_artist; DROP INDEX IF EXISTS songs_mbid; DROP INDEX IF EXISTS albums_artist;
    DROP INDEX IF EXISTS albums_release; DROP INDEX IF EXISTS albums_artist_cover; DROP INDEX IF EXISTS albums_popularity;
    DROP INDEX IF EXISTS albums_title_nocase; DROP INDEX IF EXISTS artists_name_nocase; DROP INDEX IF EXISTS artists_popularity;
    DROP INDEX IF EXISTS album_genres_genre; DROP INDEX IF EXISTS artist_genres_genre;
    DELETE FROM search_index;`);

  let pending = 0;
  db.exec('BEGIN');
  const tick = () => {
    pending += 1;
    if (pending >= BATCH) {
      db.exec('COMMIT');
      checkSpace();
      db.exec('BEGIN');
      pending = 0;
    }
  };

  // Small lookup tables
  const names = async (name) => {
    const map = new Map();
    for await (const row of readTable(file(name))) map.set(Number(row[0]), row[1]);
    done(name);
    return map;
  };
  const artistTypes = await names('artist_type');
  const primaryTypes = await names('release_group_primary_type');
  const statuses = await names('release_status');
  const officialStatus = [...statuses].find(([, name]) => name === 'Official')?.[0] ?? -1;
  const countries = new Map();
  for await (const row of readTable(file('iso_3166_1'))) if (!countries.has(row[0])) countries.set(row[0], row[1]);
  done('iso_3166_1');

  // Artists
  log('Loading artists');
  const existingArtists = new Map(db.prepare('SELECT mbid, id FROM artists WHERE mbid IS NOT NULL').all().map((row) => [row.mbid, row.id]));
  let nextArtist = (db.prepare('SELECT max(id) AS id FROM artists').get().id ?? 0) + 1;
  const artistLocal = new IdMap();
  const insertArtist = db.prepare('INSERT INTO artists (id, mbid, name, country, artist_type, begin_year) VALUES (?, ?, ?, ?, ?, ?)');
  let artistCount = 0;
  for await (const row of readTable(file('artist'))) {
    const known = existingArtists.get(row[1]);
    if (known) {
      artistLocal.set(Number(row[0]), known);
    } else {
      const type = artistTypes.get(Number(row[10])) ?? null;
      insertArtist.run(nextArtist, row[1], row[2], countries.get(row[11]) ?? null, type, row[4] ? Number(row[4]) : null);
      artistLocal.set(Number(row[0]), nextArtist);
      nextArtist += 1;
      artistCount += 1;
      tick();
    }
  }
  done('artist');
  existingArtists.clear();
  log(`Loaded ${artistCount.toLocaleString()} artists`);

  // Artist credits, such as "Queen & David Bowie"
  const creditText = [];
  for await (const row of readTable(file('artist_credit'))) creditText[Number(row[0])] = row[1];
  done('artist_credit');
  const creditArtist = new IdMap();
  for await (const row of readTable(file('artist_credit_name'))) {
    if (row[1] === '0') creditArtist.set(Number(row[0]), artistLocal.get(Number(row[2])));
  }
  done('artist_credit_name');

  // Release dates, and which releases have tracks
  log('Choosing the best release of each album');
  const releaseDate = new IdMap();
  const noteDate = (release, value) => {
    if (value && (!releaseDate.get(release) || value < releaseDate.get(release))) releaseDate.set(release, value);
  };
  for await (const row of readTable(file('release_country'))) noteDate(Number(row[0]), encodeDate(row[2], row[3], row[4]));
  done('release_country');
  for await (const row of readTable(file('release_unknown_country'))) noteDate(Number(row[0]), encodeDate(row[1], row[2], row[3]));
  done('release_unknown_country');
  const hasTracks = new IdMap(Uint8Array);
  for await (const row of readTable(file('medium'))) if (Number(row[7]) > 0) hasTracks.set(Number(row[1]), 1);

  // The chosen release is official if possible, has tracks, and came out earliest.
  const NO_DATE = 99999999;
  const bestRelease = new IdMap();
  const bestScore = new Float64Array(1 << 23);
  const releaseCount = new IdMap();
  const groupDate = new IdMap();
  const releaseGroup = new IdMap();
  let scores = bestScore;
  for await (const row of readTable(file('release'))) {
    const id = Number(row[0]);
    const group = Number(row[4]);
    releaseGroup.set(id, group);
    releaseCount.set(group, releaseCount.get(group) + 1);
    const date = releaseDate.get(id);
    if (date && (!groupDate.get(group) || date < groupDate.get(group))) groupDate.set(group, date);
    const score = (hasTracks.get(id) ? 0 : 2e8) + (Number(row[5]) === officialStatus ? 0 : 1e8) + (date || NO_DATE);
    if (group >= scores.length) {
      const bigger = new Float64Array(Math.max(group + 1, Math.floor(scores.length * 1.5)));
      bigger.set(scores);
      scores = bigger;
    }
    if (!bestRelease.get(group) || score < scores[group]) {
      bestRelease.set(group, id);
      scores[group] = score;
    }
  }
  done('release');
  scores = null;

  // Which albums have cover art. Without the art files, every album is assumed to have some.
  const hasArt = new IdMap(Uint8Array);
  const artKnown = has('cover_art_archive.cover_art') && has('cover_art_archive.cover_art_type');
  if (artKnown) {
    const fronts = new Set();
    for await (const row of readTable(file('cover_art_archive.cover_art_type'))) if (row[1] === '1') fronts.add(row[0]);
    done('cover_art_archive.cover_art_type');
    for await (const row of readTable(file('cover_art_archive.cover_art'))) {
      if (fronts.has(row[0])) {
        const group = releaseGroup.get(Number(row[1]));
        if (group) hasArt.set(group, 1);
      }
    }
    done('cover_art_archive.cover_art');
  }

  // Albums
  log('Loading albums');
  const existingAlbums = new Map(db.prepare('SELECT mbid, id FROM albums WHERE mbid IS NOT NULL').all().map((row) => [row.mbid, row.id]));
  let nextAlbum = (db.prepare('SELECT max(id) AS id FROM albums').get().id ?? 0) + 1;
  const insertAlbum = db.prepare(`INSERT INTO albums (id, mbid, title, artist_id, artist_credit, release_date, album_type, cover_url, popularity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateAlbum = db.prepare('UPDATE albums SET popularity = ? WHERE id = ?');
  const groupAlbum = new IdMap();
  const releaseAlbum = new IdMap();
  const albumArtist = new IdMap();
  const artistScore = new IdMap();
  const albumCredit = [];
  let albumCount = 0;
  let albumsWithArt = 0;
  for await (const row of readTable(file('release_group'))) {
    const group = Number(row[0]);
    const count = releaseCount.get(group);
    const artist = creditArtist.get(Number(row[3]));
    if (artist) artistScore.set(artist, artistScore.get(artist) + count);
    const known = existingAlbums.get(row[1]);
    if (known) {
      groupAlbum.set(group, known);
      updateAlbum.run(count, known);
      tick();
    } else if (artist) {
      const art = !artKnown || hasArt.get(group);
      insertAlbum.run(nextAlbum, row[1], row[2], artist, creditText[Number(row[3])] ?? '', decodeDate(groupDate.get(group)),
        primaryTypes.get(Number(row[4])) ?? 'Album', art ? `https://coverartarchive.org/release-group/${row[1]}/front-250` : null, count);
      groupAlbum.set(group, nextAlbum);
      albumArtist.set(nextAlbum, artist);
      albumCredit[nextAlbum] = creditText[Number(row[3])] ?? '';
      if (bestRelease.get(group)) releaseAlbum.set(bestRelease.get(group), nextAlbum);
      if (art) albumsWithArt += 1;
      nextAlbum += 1;
      albumCount += 1;
      tick();
    }
  }
  done('release_group');
  existingAlbums.clear();
  log(`Loaded ${albumCount.toLocaleString()} albums, ${albumsWithArt.toLocaleString()} with cover art`);

  // Each album's discs
  const mediumAlbum = new IdMap();
  const mediumDisc = new IdMap(Uint16Array);
  for await (const row of readTable(file('medium'))) {
    const album = releaseAlbum.get(Number(row[1]));
    if (album) {
      mediumAlbum.set(Number(row[0]), album);
      mediumDisc.set(Number(row[0]), Number(row[2]));
    }
  }
  done('medium');

  // Song IDs take 16 bytes each, kept outside normal memory
  log('Reading recordings');
  let recordingIds = Buffer.alloc(16 * (1 << 24));
  for await (const row of readTable(file('recording'))) {
    const id = Number(row[0]);
    if ((id + 1) * 16 > recordingIds.length) {
      const bigger = Buffer.alloc(Math.max((id + 1) * 16, Math.floor(recordingIds.length * 1.5)));
      recordingIds.copy(bigger);
      recordingIds = bigger;
    }
    uuidToBytes(row[1], recordingIds, id * 16);
  }
  done('recording');

  // Songs
  log('Loading songs. This is the longest step.');
  const insertSong = db.prepare(`INSERT OR IGNORE INTO songs (mbid, title, album_id, artist_id, artist_credit, disc, position, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  let songCount = 0;
  for await (const row of readTable(file('track'))) {
    const medium = Number(row[3]);
    const album = mediumAlbum.get(medium);
    if (album && row[11] !== 't') {
      const recording = Number(row[2]);
      const credit = Number(row[7]);
      const mbid = (recording + 1) * 16 <= recordingIds.length ? bytesToUuid(recordingIds, recording * 16) : null;
      insertSong.run(mbid, row[6], album, creditArtist.get(credit) || albumArtist.get(album), creditText[credit] ?? albumCredit[album] ?? '',
        mediumDisc.get(medium) || 1, Number(row[4]), row[8] ? Number(row[8]) : null);
      songCount += 1;
      if (songCount % 5000000 === 0) log(`Loaded ${songCount.toLocaleString()} songs`);
      tick();
    }
  }
  done('track');
  recordingIds = null;
  log(`Loaded ${songCount.toLocaleString()} songs`);

  // Genres
  const genreIds = new Map(db.prepare('SELECT name, id FROM genres').all().map((row) => [row.name, row.id]));
  const slugs = new Set(db.prepare('SELECT slug FROM genres').all().map((row) => row.slug));
  const insertGenre = db.prepare('INSERT INTO genres (name, slug) VALUES (?, ?)');
  for await (const row of readTable(file('genre'))) {
    const name = row[2].trim().toLowerCase();
    if (name && !genreIds.has(name)) {
      let slug = slugify(name);
      for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${slugify(name)}-${suffix}`;
      slugs.add(slug);
      genreIds.set(name, Number(insertGenre.run(name, slug).lastInsertRowid));
    }
  }
  done('genre');
  if (has('tag') && has('release_group_tag') && has('artist_tag')) {
    log('Loading genres');
    const tagGenre = new IdMap();
    for await (const row of readTable(file('tag'))) {
      const genre = genreIds.get(row[1]?.trim().toLowerCase());
      if (genre) tagGenre.set(Number(row[0]), genre);
    }
    done('tag');
    const link = async (name, mapId, sql) => {
      const statement = db.prepare(sql);
      const linked = new IdMap(Uint8Array);
      for await (const row of readTable(file(name))) {
        const genre = tagGenre.get(Number(row[1]));
        const id = mapId(Number(row[0]));
        if (genre && id && Number(row[2]) > 0 && linked.get(id) < MAX_GENRES) {
          statement.run(id, genre);
          linked.set(id, linked.get(id) + 1);
          tick();
        }
      }
      done(name);
    };
    await link('release_group_tag', (id) => groupAlbum.get(id), 'INSERT OR IGNORE INTO album_genres (album_id, genre_id) VALUES (?, ?)');
    await link('artist_tag', (id) => artistLocal.get(id), 'INSERT OR IGNORE INTO artist_genres (artist_id, genre_id) VALUES (?, ?)');
  }

  // An artist's popularity is how many releases exist of their albums, across every edition and country.
  // MusicBrainz has no play counts, so this stands in for them when ordering search results.
  const updateArtist = db.prepare('UPDATE artists SET popularity = ? WHERE id = ?');
  artistScore.data.forEach((score, artist) => {
    if (score) {
      updateArtist.run(score, artist);
      tick();
    }
  });
  db.exec('COMMIT');

  log('Building indexes');
  db.exec(`CREATE INDEX albums_artist ON albums(artist_id);
    CREATE INDEX albums_release ON albums(release_date DESC, id DESC);
    CREATE INDEX albums_artist_cover ON albums(artist_id, album_type, release_date);
    CREATE INDEX albums_popularity ON albums(popularity DESC);
    CREATE INDEX albums_title_nocase ON albums(title COLLATE NOCASE, popularity DESC);
    CREATE INDEX artists_name_nocase ON artists(name COLLATE NOCASE, popularity DESC);
    CREATE INDEX artists_popularity ON artists(popularity DESC);
    CREATE INDEX songs_artist ON songs(artist_id);
    CREATE INDEX songs_mbid ON songs(mbid);
    CREATE INDEX album_genres_genre ON album_genres(genre_id);
    CREATE INDEX artist_genres_genre ON artist_genres(genre_id);`);
  checkSpace();

  // Search returns earlier rows first, so loading the most popular music first keeps searches fast.
  log('Building search');
  db.exec(`INSERT INTO search_index (kind, ref_id, name, context) SELECT 'artist', id, name, '' FROM artists ORDER BY popularity DESC;`);
  db.exec(`INSERT INTO search_index (kind, ref_id, name, context) SELECT 'genre', id, name, '' FROM genres;`);
  db.exec(`INSERT INTO search_index (kind, ref_id, name, context) SELECT 'album', id, title, artist_credit FROM albums ORDER BY popularity DESC;`);
  checkSpace();
  db.exec(`INSERT INTO search_index (kind, ref_id, name, context)
    SELECT 'song', songs.id, songs.title, songs.artist_credit FROM albums CROSS JOIN songs ON songs.album_id = albums.id ORDER BY albums.popularity DESC;`);
  checkSpace();
  db.exec(`CREATE TRIGGER artists_search AFTER INSERT ON artists BEGIN
      INSERT INTO search_index (kind, ref_id, name, context) VALUES ('artist', new.id, new.name, '');
    END;
    CREATE TRIGGER albums_search AFTER INSERT ON albums BEGIN
      INSERT INTO search_index (kind, ref_id, name, context) VALUES ('album', new.id, new.title, new.artist_credit);
    END;
    CREATE TRIGGER songs_search AFTER INSERT ON songs BEGIN
      INSERT INTO search_index (kind, ref_id, name, context) VALUES ('song', new.id, new.title, new.artist_credit);
    END;
    CREATE TRIGGER genres_search AFTER INSERT ON genres BEGIN
      INSERT INTO search_index (kind, ref_id, name, context) VALUES ('genre', new.id, new.name, '');
    END;`);

  // The bulk artist list and its queue aren't needed anymore.
  db.prepare(`UPDATE import_queue SET status = 'done', payload = NULL, finished_at = datetime('now') WHERE status != 'done'`).run();
  db.prepare(`INSERT OR REPLACE INTO app_state (key, value) VALUES ('full_import_at', datetime('now'))`).run();
  db.exec('ANALYZE; PRAGMA locking_mode = NORMAL; PRAGMA synchronous = FULL;');
  return { artists: artistCount, albums: albumCount, albumsWithArt, songs: songCount };
}

async function latestFolder(fetchImpl, hosts) {
  let lastError;
  for (const host of hosts) {
    try {
      const response = await fetchImpl(`${host}/LATEST`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${host} answered ${response.status}`);
      const name = (await response.text()).trim();
      if (!/^\d{8}-\d{6}$/.test(name)) throw new Error(`Unexpected latest version "${name}"`);
      return { host, name, url: `${host}/${name}` };
    } catch (err) {
      lastError = err;
    }
  }
  throw new ImportStopped(`Couldn't reach the MusicBrainz download site: ${lastError.message}`);
}

async function remoteSize(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new ImportStopped(`Couldn't find ${url} (status ${response.status}).`);
  return Number(response.headers.get('content-length') || 0);
}

// Picks up where it left off if a download was interrupted.
async function download(fetchImpl, url, target, expectedSize, log) {
  const partial = `${target}.part`;
  const already = existsSync(partial) ? statSync(partial).size : 0;
  if (!expectedSize || already < expectedSize) {
    const response = await fetchImpl(url, already ? { headers: { Range: `bytes=${already}-` } } : {});
    if (!response.ok) throw new ImportStopped(`Download failed with status ${response.status}: ${url}`);
    const resumed = response.status === 206;
    const output = createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
    let received = resumed ? already : 0;
    let nextReport = received + GB;
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      if (received >= nextReport) {
        log(`Downloaded ${formatGb(received)}${expectedSize ? ` of ${formatGb(expectedSize)}` : ''}`);
        nextReport += GB;
      }
    });
    await pipeline(body, output);
  }
  renameSync(partial, target);
}

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function extract(archive, tables, cwd) {
  return new Promise((resolve, reject) => {
    const members = tables.map((table) => `mbdump/${table}`);
    const child = spawn('tar', ['-xjf', archive, ...members], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', (err) => reject(new ImportStopped(`Couldn't run tar: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ImportStopped(`Couldn't unpack ${archive}: ${errors.slice(0, 500)}`));
    });
  });
}

function tarAvailable() {
  return new Promise((resolve) => {
    const child = spawn('tar', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export async function siteIsRunning(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runFullImport({
  databasePath, workDir = join(dirname(databasePath), 'full-import'), port = 3000, includeGenres = true,
  checkOnly = false, fetchImpl = fetch, hosts = DOWNLOAD_HOSTS, log = defaultLog, spaceForDatabase = SPACE_FOR_DATABASE,
}) {
  const archives = [ARCHIVES.core, ARCHIVES.art, ...(includeGenres ? [ARCHIVES.genres] : [])];
  mkdirSync(workDir, { recursive: true });
  const latest = await latestFolder(fetchImpl, hosts);
  const sizes = await Promise.all(archives.map((archive) => remoteSize(fetchImpl, `${latest.url}/${archive.file}`)));
  const downloadSize = sizes.reduce((sum, size) => sum + size, 0);
  const needed = downloadSize + spaceForDatabase;
  const free = freeSpace(workDir);
  log(`Latest catalog: ${latest.name}. Download: ${formatGb(downloadSize)}. Needed: at least ${formatGb(needed)}. Free: ${formatGb(free)}.`);
  const memory = totalmem();
  if (memory < 8 * GB) log(`This computer has ${formatGb(memory)} of memory. The import works best with at least 8 GB.`);
  if (!(await tarAvailable())) throw new ImportStopped('The import needs the tar program, which comes with Windows 10 and later, macOS, and Linux. It wasn\'t found.');
  if (checkOnly) {
    log(free < needed ? `Not enough free space. Free up ${formatGb(needed - free)} or use another drive.` : 'Ready. There is enough free space.');
    return { checkOnly: true, needed, free, downloadSize };
  }
  if (free < needed) {
    throw new ImportStopped(`This needs at least ${formatGb(needed)} free, and the drive has ${formatGb(free)}. Free up space, or choose another drive with --work-dir and DATABASE_PATH.`);
  }
  if (await siteIsRunning(port, fetchImpl)) {
    throw new ImportStopped('The site is running. Stop it with Ctrl+C, then run the import again.');
  }

  const sumsResponse = await fetchImpl(`${latest.url}/SHA256SUMS`, { signal: AbortSignal.timeout(30000) });
  if (!sumsResponse.ok) throw new ImportStopped(`Couldn't get the checksum file (status ${sumsResponse.status}).`);
  const sums = new Map((await sumsResponse.text()).split('\n').map((line) => line.trim().split(/\s+\*?/)).map(([sum, name]) => [name, sum]));

  for (const [index, archive] of archives.entries()) {
    const target = join(workDir, archive.file);
    if (!existsSync(target)) {
      log(`Downloading ${archive.file}`);
      await download(fetchImpl, `${latest.url}/${archive.file}`, target, sizes[index], log);
    }
    log(`Verifying ${archive.file}`);
    const actual = await sha256(target);
    if (actual !== sums.get(archive.file)) {
      rmSync(target, { force: true });
      throw new ImportStopped(`${archive.file} failed its integrity check and was deleted. Run the import again.`);
    }
  }

  for (const archive of archives) {
    log(`Unpacking ${archive.file}. This can take an hour.`);
    await extract(archive.file, archive.tables, workDir);
    rmSync(join(workDir, archive.file), { force: true });
  }

  const newPath = `${databasePath}.full`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${newPath}${suffix}`, { force: true });
  mkdirSync(dirname(databasePath), { recursive: true });
  const current = openDb(databasePath);
  current.prepare('VACUUM INTO ?').run(newPath);
  current.close();

  const minimumFree = Math.min(MINIMUM_FREE, spaceForDatabase);
  const checkSpace = () => {
    const left = freeSpace(dirname(newPath));
    if (left < minimumFree) throw new ImportStopped(`Stopped with ${formatGb(left)} left, so the drive doesn't fill up. Your site is unchanged.`);
  };
  const db = openDb(newPath);
  let result;
  try {
    result = await buildCatalog(db, join(workDir, 'mbdump'), { log, checkSpace });
    db.close();
  } catch (err) {
    try { db.close(); } catch { /* It may already be closed. */ }
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${newPath}${suffix}`, { force: true });
    throw err;
  }

  if (await siteIsRunning(port, fetchImpl)) {
    throw new ImportStopped(`The new library is ready at ${newPath}, but the site is running. Stop it, then run the import again.`);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const old = `${databasePath}${suffix}`;
    if (existsSync(old)) renameSync(old, `${databasePath}.before-full-import${suffix}`);
  }
  renameSync(newPath, databasePath);
  rmSync(workDir, { recursive: true, force: true });
  log(`Finished. ${result.artists.toLocaleString()} artists, ${result.albums.toLocaleString()} albums, ${result.songs.toLocaleString()} songs.`);
  return result;
}
