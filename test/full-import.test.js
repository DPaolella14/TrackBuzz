import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { getTopic, isFullCatalog, search } from '../src/catalog.js';
import { openDb } from '../src/db.js';
import { ARCHIVES, ImportStopped, buildCatalog, readTable, runFullImport } from '../src/full-import.js';
import { enqueueImport } from '../src/importer.js';
import { createPost } from '../src/posts.js';
import { Client, startApp } from './helpers.js';

const uuid = (prefix, n) => `${String(prefix).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const N = '\\N';
const row = (...cols) => cols.map((col) => (col === null ? N : col)).join('\t');
const roots = [];

// Column orders come from MusicBrainz's published table definitions.
function dataFiles(root) {
  const folder = join(root, 'mbdump');
  mkdirSync(folder, { recursive: true });
  const write = (name, rows) => writeFileSync(join(folder, name), rows.map((cols) => row(...cols)).join('\n') + '\n');
  const artist = (id, gid, name, year, type, area) => [id, gid, name, name, year, null, null, null, null, null, type, area, null, '', 0, null, 'f', null, null];
  write('artist_type', [[1, 'Person', null, 1, null, 'x'], [2, 'Group', null, 2, null, 'y']]);
  write('release_group_primary_type', [[1, 'Album', null, 1, null, 'x'], [2, 'Single', null, 2, null, 'y'], [3, 'EP', null, 3, null, 'z']]);
  write('release_status', [[1, 'Official', null, 1, null, 'x'], [2, 'Promotion', null, 2, null, 'y']]);
  write('iso_3166_1', [[221, 'GB'], [222, 'US']]);
  write('artist', [
    artist(10, uuid(1, 10), 'Alice in Chains', 1987, 2, 222),
    artist(11, uuid(1, 11), 'Obscure Beyoncé Tribute', null, null, null),
    artist(12, uuid(1, 12), 'Already Here', 1970, 2, 221),
    artist(13, uuid(1, 13), 'Guest Singer', 2001, 1, 222),
  ]);
  write('artist_credit', [[100, 'Alice in Chains', 1, 5, '2020', 0, 'c1'], [101, 'Obscure Beyoncé Tribute', 1, 1, '2020', 0, 'c2'], [102, 'Already Here', 1, 1, '2020', 0, 'c3'], [103, 'Alice in Chains feat. Guest Singer', 2, 1, '2020', 0, 'c4']]);
  write('artist_credit_name', [[100, 0, 10, 'Alice in Chains', ''], [101, 0, 11, 'Obscure', ''], [102, 0, 12, 'Already Here', ''], [103, 0, 10, 'Alice in Chains', ' feat. '], [103, 1, 13, 'Guest Singer', '']]);
  const group = (id, gid, name, credit, type) => [id, gid, name, credit, type, '', 0, null];
  write('release_group', [
    group(200, uuid(2, 200), 'Dirt', 100, 1),
    group(201, uuid(2, 201), 'No Cover EP', 101, 3),
    group(202, uuid(2, 202), 'Kept Album', 102, 1),
    group(203, uuid(2, 203), 'Tab\\tName', 100, null),
  ]);
  const release = (id, gid, name, credit, grp, status) => [id, gid, name, credit, grp, status, null, null, null, null, '', 0, -1, null];
  write('release', [
    release(300, uuid(3, 300), 'Dirt (reissue)', 100, 200, 1),
    release(301, uuid(3, 301), 'Dirt', 100, 200, 1),
    release(302, uuid(3, 302), 'Dirt (promo)', 100, 200, 2),
    release(303, uuid(3, 303), 'No Cover EP', 101, 201, 1),
    release(304, uuid(3, 304), 'Kept Album', 102, 202, 1),
    release(305, uuid(3, 305), 'Empty', 100, 203, 1),
    release(306, uuid(3, 306), 'Dirt (no tracks, earliest)', 100, 200, 1),
  ]);
  write('release_country', [[300, 222, 2010, 1, 1], [301, 222, 1992, 9, 29], [302, 222, 1991, 1, 1], [306, 222, 1980, 1, 1]]);
  write('release_unknown_country', [[303, 2005, 6, null]]);
  const medium = (id, rel, pos, count) => [id, rel, pos, null, '', 0, null, count, 'g'];
  write('medium', [medium(400, 300, 1, 1), medium(401, 301, 1, 2), medium(402, 301, 2, 1), medium(403, 302, 1, 1), medium(404, 303, 1, 1), medium(405, 304, 1, 1), medium(406, 306, 1, 0)]);
  const recording = (id, gid, name) => [id, gid, name, 100, 1000, '', 0, null, 'f'];
  write('recording', [recording(500, uuid(5, 500), 'Them Bones'), recording(501, uuid(5, 501), 'Rooster'), recording(502, uuid(5, 502), 'Would?'), recording(503, uuid(5, 503), 'Quiet Song'), recording(504, uuid(5, 504), 'Kept Song'), recording(505, uuid(5, 505), 'Wrong')]);
  const track = (id, rec, med, pos, name, credit, length, data = 'f') => [id, uuid(6, id), rec, med, pos, String(pos), name, credit, length, 0, null, data];
  write('track', [
    track(600, 505, 400, 1, 'Reissue Bonus', 100, 1000),
    track(601, 500, 401, 1, 'Them Bones', 100, 150000),
    track(602, 501, 401, 2, 'Rooster', 103, null),
    track(603, 502, 402, 1, 'Would?', 100, 205000),
    track(604, 505, 401, 3, 'Data Track', 100, 1, 't'),
    track(605, 503, 404, 1, 'Quiet Song', 101, 90000),
    track(606, 504, 405, 1, 'Should Be Skipped', 102, 1000),
    track(607, 505, 403, 1, 'Promo Only', 100, 1000),
  ]);
  write('genre', [[1, 'g1', 'Grunge', '', 0, null], [2, 'g2', 'Alternative Metal', '', 0, null]]);
  write('tag', [[1, 'grunge', 5], [2, 'seen live', 9], [3, 'alternative metal', 2]]);
  write('release_group_tag', [[200, 1, 4, null], [200, 2, 9, null], [200, 3, 0, null]]);
  write('artist_tag', [[10, 1, 3, null], [10, 3, 2, null]]);
  write('cover_art_archive.cover_art', [[7000000001, 301, '', 1, 1, null, 0, 'image/jpeg', 1, 1, 1, 1], [7000000002, 303, '', 1, 1, null, 0, 'image/jpeg', 1, 1, 1, 1]]);
  write('cover_art_archive.cover_art_type', [[7000000001, 1], [7000000002, 2]]);
  return folder;
}

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tb-full-'));
  roots.push(root);
  return root;
}
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function dbWithExistingData() {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO users (username, username_key, email, password_hash) VALUES ('fan', 'fan', 'f@example.com', 'x')`).run();
  const artist = Number(db.prepare(`INSERT INTO artists (id, mbid, name) VALUES (7, ?, 'Already Here')`).run(uuid(1, 12)).lastInsertRowid);
  const album = Number(db.prepare(`INSERT INTO albums (id, mbid, title, artist_id, artist_credit, album_type) VALUES (9, ?, 'Kept Album', ?, 'Already Here', 'Album')`).run(uuid(2, 202), artist).lastInsertRowid);
  db.prepare(`INSERT INTO songs (id, mbid, title, album_id, artist_id, artist_credit, position) VALUES (3, 'kept-song', 'Kept Song', ?, ?, 'Already Here', 1)`).run(album, artist);
  createPost(db, { userId: 1, type: 'album', topicId: album, tab: 'story', body: 'My memory', rating: null });
  return { db, artist, album };
}

describe('reading the data files', () => {
  it('handles empty values and escapes', async () => {
    const root = tempRoot();
    const path = join(root, 'table');
    writeFileSync(path, 'a\\tb\t\\N\tback\\\\slash\tline\\nbreak\n');
    const rows = [];
    for await (const cols of readTable(path)) rows.push(cols);
    assert.deepEqual(rows, [['a\tb', null, 'back\\slash', 'line\nbreak']]);
  });
});

describe('loading the catalog', () => {
  it('builds artists, albums, songs, genres, and pictures', async () => {
    const { db } = dbWithExistingData();
    const folder = dataFiles(tempRoot());
    const result = await buildCatalog(db, folder, { log: () => {} });
    assert.deepEqual(result, { artists: 3, albums: 3, albumsWithArt: 1, songs: 4 });

    const artist = db.prepare(`SELECT * FROM artists WHERE name = 'Alice in Chains'`).get();
    assert.equal(artist.country, 'US');
    assert.equal(artist.artist_type, 'Group');
    assert.equal(artist.begin_year, 1987);
    assert.equal(artist.popularity, 5);

    const album = db.prepare(`SELECT * FROM albums WHERE title = 'Dirt'`).get();
    assert.equal(album.album_type, 'Album');
    assert.equal(album.release_date, '1980-01-01', 'earliest date among all editions');
    assert.equal(album.cover_url, `https://coverartarchive.org/release-group/${uuid(2, 200)}/front-250`);
    assert.equal(album.artist_credit, 'Alice in Chains');

    const songs = db.prepare('SELECT * FROM songs WHERE album_id = ? ORDER BY disc, position').all(album.id);
    assert.deepEqual(songs.map((song) => [song.title, song.disc, song.position, song.duration_ms]), [['Them Bones', 1, 1, 150000], ['Rooster', 1, 2, null], ['Would?', 2, 1, 205000]]);
    assert.equal(songs[0].mbid, uuid(5, 500));
    assert.equal(songs[1].artist_credit, 'Alice in Chains feat. Guest Singer');

    assert.equal(db.prepare(`SELECT cover_url FROM albums WHERE title = 'No Cover EP'`).get().cover_url, null, 'a back cover does not count');
    assert.equal(db.prepare(`SELECT release_date FROM albums WHERE title = 'No Cover EP'`).get().release_date, '2005-06');
    assert.equal(db.prepare(`SELECT title FROM albums WHERE title LIKE 'Tab%'`).get().title, 'Tab\tName');
    const genres = db.prepare(`SELECT genres.name FROM album_genres JOIN genres ON genres.id = genre_id WHERE album_id = ?`).all(album.id).map((g) => g.name);
    assert.deepEqual(genres, ['grunge'], 'real genres with votes only');
    assert.equal(db.prepare('SELECT count(*) AS n FROM artist_genres').get().n, 2);
    assert.equal(getTopic(db, 'artist', artist.id).cover_url, album.cover_url, 'artists show their album cover');
    assert.equal(isFullCatalog(db), true);
  });

  it('keeps existing IDs, so posts stay on the right page', async () => {
    const { db, artist, album } = dbWithExistingData();
    await buildCatalog(db, dataFiles(tempRoot()), { log: () => {} });
    assert.equal(db.prepare('SELECT count(*) AS n FROM artists WHERE name = ?').get('Already Here').n, 1);
    assert.equal(db.prepare('SELECT id FROM artists WHERE name = ?').get('Already Here').id, artist);
    assert.equal(db.prepare('SELECT id, popularity FROM albums WHERE title = ?').get('Kept Album').id, album);
    assert.equal(db.prepare('SELECT count(*) AS n FROM songs WHERE album_id = ?').get(album).n, 1);
    assert.equal(db.prepare('SELECT topic_id FROM posts').get().topic_id, album);
  });

  it('searches every kind, instantly and in order', async () => {
    const { db } = dbWithExistingData();
    await buildCatalog(db, dataFiles(tempRoot()), { log: () => {} });
    assert.equal(search(db, 'alice in chains').items[0].name, 'Alice in Chains');
    assert.equal(search(db, 'alice in cha').items[0].name, 'Alice in Chains');
    assert.equal(search(db, 'beyonce').items[0].name, 'Obscure Beyoncé Tribute');
    assert.equal(search(db, 'rooster').items[0].name, 'Rooster');
    assert.equal(search(db, 'grunge').items[0].type, 'genre');
    assert.deepEqual(search(db, 'dirt', { kind: 'album' }).items.map((item) => item.name), ['Dirt']);
    assert.equal(search(db, 'them bones alice').items[0].name, 'Them Bones', 'matches title and artist together');
    assert.deepEqual(search(db, 'zzzz').items, []);
    assert.equal(search(db, 'them b').items[0].name, 'Them Bones', 'partly typed last word');
    assert.deepEqual(search(db, 'them x').items, [], 'the last letter still has to match');
    assert.equal(search(db, 'a').items[0].name, 'Alice in Chains', 'one letter shows popular music');
  });

  it('keeps search up to date for releases added later', async () => {
    const { db } = dbWithExistingData();
    await buildCatalog(db, dataFiles(tempRoot()), { log: () => {} });
    db.prepare(`INSERT INTO artists (mbid, name) VALUES ('new', 'Brand New Band')`).run();
    assert.equal(search(db, 'brand new band').items[0].name, 'Brand New Band');
  });

  it('stops when told the drive is too full', async () => {
    const { db } = dbWithExistingData();
    let calls = 0;
    const checkSpace = () => {
      calls += 1;
      throw new ImportStopped('full');
    };
    await assert.rejects(buildCatalog(db, dataFiles(tempRoot()), { log: () => {}, checkSpace }), ImportStopped);
    assert.equal(calls, 1);
  });

  it('works without genres, whose license is non-commercial', async () => {
    const { db } = dbWithExistingData();
    const folder = dataFiles(tempRoot());
    for (const name of ARCHIVES.genres.tables) rmSync(join(folder, name));
    await buildCatalog(db, folder, { log: () => {} });
    assert.equal(db.prepare('SELECT count(*) AS n FROM album_genres').get().n, 0);
  });

  it('deletes each data file after using it', async () => {
    const { db } = dbWithExistingData();
    const folder = dataFiles(tempRoot());
    await buildCatalog(db, folder, { log: () => {} });
    assert.equal(existsSync(join(folder, 'track')), false);
    assert.equal(existsSync(join(folder, 'artist')), false);
  });
});

describe('after a full import', () => {
  it('turns off outside search on the site', async () => {
    const app = await startApp();
    try {
      const client = new Client(app.base);
      assert.ok(!(await client.get('/')).text.includes('data-full-catalog'));
      app.db.prepare(`INSERT INTO app_state (key, value) VALUES ('full_import_at', 'now')`).run();
      const { text } = await client.get('/search?q=anything');
      assert.ok(text.includes('data-full-catalog'));
      assert.ok(!text.includes('data-live-results'));
      assert.ok(text.includes('Nothing matches'));
    } finally {
      await app.close();
    }
  });
});

describe('the whole import, start to finish', () => {
  function site(archives, { sumFor = (name, sum) => sum, running = false } = {}) {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
      requests.push(`${options.method || 'GET'} ${url}`);
      if (url.includes('127.0.0.1')) {
        if (running) return new Response('{}');
        throw new Error('not running');
      }
      const name = url.split('/').pop();
      if (name === 'LATEST') return new Response('20261031-001001\n');
      if (name === 'SHA256SUMS') {
        return new Response(Object.entries(archives).map(([file, data]) => `${sumFor(file, createHash('sha256').update(data).digest('hex'))} *${file}`).join('\n'));
      }
      const data = archives[name];
      if (!data) return new Response('', { status: 404 });
      return new Response(options.method === 'HEAD' ? null : data, { headers: { 'content-length': String(data.length) } });
    };
    return { fetchImpl, requests };
  }

  function buildArchives(root) {
    dataFiles(root);
    const archives = {};
    for (const archive of [ARCHIVES.core, ARCHIVES.art, ARCHIVES.genres]) {
      execFileSync('tar', ['-cjf', archive.file, ...archive.tables.map((table) => `mbdump/${table}`)], { cwd: root });
      archives[archive.file] = readFileSync(join(root, archive.file));
    }
    return archives;
  }

  function prepare() {
    const source = tempRoot();
    const site_ = tempRoot();
    const databasePath = join(site_, 'data', 'trackbuzz.db');
    const db = openDb(databasePath);
    db.prepare(`INSERT INTO artists (mbid, name) VALUES (?, 'Already Here')`).run(uuid(1, 12));
    enqueueImport(db, 'artist', 'Someone');
    db.close();
    return { archives: buildArchives(source), databasePath, site: site_ };
  }

  it('downloads, verifies, unpacks, loads, and swaps in the new library', async () => {
    const { archives, databasePath } = prepare();
    const { fetchImpl } = site(archives);
    const result = await runFullImport({ databasePath, fetchImpl, hosts: ['https://example.test/x'], log: () => {} });
    assert.equal(result.songs, 5);
    const db = openDb(databasePath);
    assert.equal(search(db, 'alice in chains').items[0].name, 'Alice in Chains');
    assert.equal(db.prepare(`SELECT count(*) AS n FROM import_queue WHERE status = 'pending'`).get().n, 0);
    db.close();
    assert.equal(existsSync(`${databasePath}.before-full-import`), true, 'keeps the old library');
    assert.equal(existsSync(join(databasePath, '..', 'full-import')), false, 'cleans up');
  });

  it('refuses a corrupted download, and leaves the site alone', async () => {
    const { archives, databasePath } = prepare();
    const { fetchImpl } = site(archives, { sumFor: () => 'bad' });
    await assert.rejects(runFullImport({ databasePath, fetchImpl, hosts: ['https://example.test/x'], log: () => {} }), /integrity check/);
    const db = openDb(databasePath);
    assert.equal(isFullCatalog(db), false);
    db.close();
  });

  it('refuses to start while the site is running', async () => {
    const { archives, databasePath } = prepare();
    const { fetchImpl } = site(archives, { running: true });
    await assert.rejects(runFullImport({ databasePath, fetchImpl, hosts: ['https://example.test/x'], log: () => {} }), /site is running/);
  });

  it('can check space without changing anything', async () => {
    const { archives, databasePath } = prepare();
    const { fetchImpl, requests } = site(archives);
    const result = await runFullImport({ databasePath, fetchImpl, hosts: ['https://example.test/x'], checkOnly: true, log: () => {} });
    assert.equal(result.checkOnly, true);
    assert.ok(result.downloadSize > 0);
    assert.ok(!requests.some((request) => request.startsWith('GET') && request.endsWith('.bz2')));
  });

  it('tries the second download site if the first is down', async () => {
    const { archives, databasePath } = prepare();
    const inner = site(archives).fetchImpl;
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push(url);
      if (url.startsWith('https://down.test')) throw new Error('down');
      return inner(url, options);
    };
    const result = await runFullImport({ databasePath, fetchImpl, hosts: ['https://down.test/x', 'https://up.test/x'], checkOnly: true, log: () => {} });
    assert.equal(result.checkOnly, true);
    assert.ok(seen.some((url) => url.startsWith('https://up.test')));
  });

  it('stops before starting if the drive is too small', async () => {
    const { archives, databasePath } = prepare();
    const { fetchImpl } = site(archives);
    // Huge reported download size
    const bigFetch = async (url, options = {}) => {
      if (options.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(1e16) } });
      return fetchImpl(url, options);
    };
    await assert.rejects(runFullImport({ databasePath, fetchImpl: bigFetch, hosts: ['https://example.test/x'], log: () => {} }), /free/);
  });
});

