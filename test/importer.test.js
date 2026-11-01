import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { search } from '../src/catalog.js';
import { openDb } from '../src/db.js';
import {
  Importer, chooseRelease, creditText, enqueueImport, enqueueStarterCatalog, isWantedGroup, processNextImport,
} from '../src/importer.js';
import { MusicBrainzClient, escapeLucene } from '../src/musicbrainz.js';

const ARTIST = { id: 'artist-1', name: 'Test Artist', type: 'Group', country: 'US', 'life-span': { begin: '1999-02-01' }, genres: [{ name: 'Dream Pop', count: 5 }] };
const group = (id, overrides = {}) => ({
  id,
  title: `Record ${id}`,
  'primary-type': 'Album',
  'secondary-types': [],
  'first-release-date': '2026-10-30',
  'artist-credit': [{ name: 'Test Artist', joinphrase: ' & ', artist: { id: 'artist-1', name: 'Test Artist' } }, { name: 'Guest', artist: { id: 'artist-2', name: 'Guest' } }],
  genres: [{ name: 'Dream Pop', count: 3 }, { name: 'Shoegaze', count: 1 }],
  ...overrides,
});
const releases = {
  releases: [
    { id: 'later', date: '2027-01-01', media: [{ position: 1, tracks: [{ position: 1, title: 'Wrong', recording: { id: 'x' } }] }] },
    { id: 'first', date: '2026-10-30', media: [{ position: 1, tracks: [
      { position: 1, title: 'Opening Song', length: 200000, recording: { id: 'rec-1' } },
      { position: 2, title: 'Second Song', recording: { id: 'rec-2', length: 180000 } },
    ] }] },
  ],
};

function fakeMb(pages = {}) {
  const calls = [];
  return {
    calls,
    lookupArtist: async (id) => { calls.push(`artist:${id}`); return id === 'artist-1' ? ARTIST : { id, name: id }; },
    lookupReleaseGroup: async (id) => { calls.push(`group:${id}`); return (pages.groups || {})[id] || group(id); },
    browseReleases: async (id) => { calls.push(`releases:${id}`); return releases; },
    searchReleaseGroups: async (query, { offset = 0 } = {}) => { calls.push(`search:${query}:${offset}`); return pages.search?.(query, offset) ?? { 'release-groups': [], count: 0 }; },
    searchArtists: async () => pages.artists ?? { artists: [] },
    searchRecordings: async () => pages.recordings ?? { recordings: [] },
    browseArtistReleaseGroups: async () => pages.artistGroups ?? { 'release-groups': [] },
  };
}

describe('importing a release', () => {
  it('stores the artist, album, songs, genres, and makes them searchable', async () => {
    const db = openDb(':memory:');
    const mb = fakeMb();
    assert.equal(await new Importer(db, mb).importReleaseGroup('g1'), true);
    const album = db.prepare('SELECT * FROM albums').get();
    assert.equal(album.artist_credit, 'Test Artist & Guest');
    assert.equal(album.cover_url, 'https://coverartarchive.org/release-group/g1/front-250');
    const songs = db.prepare('SELECT title, position, duration_ms FROM songs ORDER BY position').all();
    assert.deepEqual(songs.map((song) => song.title), ['Opening Song', 'Second Song']);
    assert.deepEqual(songs.map((song) => song.duration_ms), [200000, 180000]);
    assert.equal(db.prepare('SELECT begin_year FROM artists').get().begin_year, 1999);
    assert.equal(db.prepare('SELECT count(*) AS n FROM album_genres').get().n, 2);
    assert.equal(search(db, 'opening').items[0].name, 'Opening Song');
    assert.equal(search(db, 'shoegaze').items[0].type, 'genre');
  });

  it('skips releases it already has without calling MusicBrainz again', async () => {
    const db = openDb(':memory:');
    const mb = fakeMb();
    const importer = new Importer(db, mb);
    await importer.importReleaseGroup('g1');
    const callsBefore = mb.calls.length;
    assert.equal(await importer.importReleaseGroup('g1'), false);
    assert.equal(mb.calls.length, callsBefore);
  });

  it('skips compilations and keeps live albums', () => {
    assert.equal(isWantedGroup({ 'primary-type': 'Album', 'secondary-types': ['Compilation'] }), false);
    assert.equal(isWantedGroup({ 'primary-type': 'Album', 'secondary-types': ['Live'] }), true);
    assert.equal(isWantedGroup({ 'primary-type': 'Broadcast' }), false);
  });

  it('picks the earliest release that has tracks, and joins artist credits', () => {
    assert.equal(chooseRelease(releases.releases).id, 'first');
    assert.equal(chooseRelease([{ id: 'empty', date: '2000', media: [] }]), null);
    assert.equal(creditText([{ name: 'A', joinphrase: ' feat. ' }, { artist: { name: 'B' } }]), 'A feat. B');
  });
});

describe('staying up to date', () => {
  it('imports new releases across pages, up to the limit, and records the run', async () => {
    const db = openDb(':memory:');
    const seen = [];
    const mb = fakeMb({
      search(query, offset) {
        seen.push(query);
        if (!query.includes('primarytype:album')) return { 'release-groups': [{ id: 'single-1' }], count: 1 };
        return offset === 0 ? { 'release-groups': [{ id: 'a' }, { id: 'b' }], count: 3 } : { 'release-groups': [{ id: 'c' }], count: 3 };
      },
    });
    const importer = new Importer(db, mb);
    assert.equal(await importer.runSync({ maxNew: 10, now: new Date('2026-11-01T00:00:00Z') }), 4);
    assert.match(seen[0], /firstreleasedate:\[2026-10-25 TO 2026-11-01\]/);
    const run = db.prepare('SELECT status, albums_added FROM sync_runs').get();
    assert.equal(run.status, 'done');
    assert.equal(run.albums_added, 4);
    assert.equal(await importer.runSync({ maxNew: 10 }), 0, 'second run adds nothing new');
  });

  it('stops at the per-run limit', async () => {
    const db = openDb(':memory:');
    const mb = fakeMb({ search: () => ({ 'release-groups': [{ id: 'a' }, { id: 'b' }, { id: 'c' }], count: 3 }) });
    assert.equal(await new Importer(db, mb).syncNewReleases({ maxNew: 2 }), 2);
  });

  it('keeps going when one release fails, and records a run that fails outright', async () => {
    const db = openDb(':memory:');
    const mb = fakeMb({ search: (query) => (query.includes('album') ? { 'release-groups': [{ id: 'bad' }, { id: 'good' }], count: 2 } : { 'release-groups': [], count: 0 }) });
    const original = mb.lookupReleaseGroup;
    mb.lookupReleaseGroup = async (id) => { if (id === 'bad') throw new Error('boom'); return original(id); };
    assert.equal(await new Importer(db, mb).runSync({ maxNew: 5 }), 1);

    mb.searchReleaseGroups = async () => { throw new Error('offline'); };
    await assert.rejects(new Importer(db, mb).runSync({ maxNew: 5 }));
    assert.equal(db.prepare('SELECT status FROM sync_runs ORDER BY id DESC').get().status, 'failed');
  });

  it('queues the starter artists only for an empty library', () => {
    const db = openDb(':memory:');
    assert.ok(enqueueStarterCatalog(db) > 10);
    assert.equal(enqueueStarterCatalog(db), 0);
  });
});

describe('search requests', () => {
  it('imports the best matches and marks the job done', async () => {
    const db = openDb(':memory:');
    const mb = fakeMb({
      artists: { artists: [{ id: 'artist-1', name: 'Test Artist', score: 100 }] },
      artistGroups: { 'release-groups': [
        { id: 'comp', 'primary-type': 'Album', 'secondary-types': ['Compilation'] },
        { id: 'real', 'primary-type': 'Album', 'secondary-types': [] },
      ] },
      recordings: { recordings: [{ id: 'r', score: 95, releases: [{ 'release-group': { id: 'from-song' } }] }, { id: 'weak', score: 40, releases: [{ 'release-group': { id: 'weak' } }] }] },
    });
    enqueueImport(db, 'search', 'Test Artist');
    assert.equal(await processNextImport(db, new Importer(db, mb)), true);
    assert.deepEqual(db.prepare('SELECT mbid FROM albums ORDER BY mbid').all().map((row) => row.mbid), ['from-song', 'real']);
    assert.equal(db.prepare('SELECT status FROM import_queue').get().status, 'done');
    assert.equal(await processNextImport(db, new Importer(db, mb)), false);
  });

  it('marks a failed job instead of retrying forever', async () => {
    const db = openDb(':memory:');
    const mb = fakeMb();
    mb.searchArtists = async () => { throw new Error('offline'); };
    enqueueImport(db, 'search', 'Anything');
    await processNextImport(db, new Importer(db, mb));
    assert.equal(db.prepare('SELECT status FROM import_queue').get().status, 'failed');
  });
});

describe('MusicBrainz client', () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

  it('identifies itself, asks for JSON, and spaces out requests', async () => {
    const requests = [];
    const waits = [];
    const client = new MusicBrainzClient({
      contact: 'test@example.com',
      fetchImpl: async (url, options) => { requests.push({ url, options }); return json({ ok: true }); },
      sleep: async (ms) => { waits.push(ms); },
    });
    await Promise.all([client.lookupArtist('abc'), client.lookupArtist('def')]);
    assert.equal(requests[0].options.headers['User-Agent'], 'TrackBuzz/0.1 ( test@example.com )');
    assert.equal(requests[0].url.href, 'https://musicbrainz.org/ws/2/artist/abc?inc=genres&fmt=json');
    assert.ok(waits[0] > 1000 && waits[0] <= 1100, `waited ${waits[0]}`);
  });

  it('retries when the service is busy, but not on a bad request', async () => {
    let attempts = 0;
    const busy = new MusicBrainzClient({
      contact: 'x', sleep: async () => {},
      fetchImpl: async () => { attempts += 1; return attempts < 3 ? json({}, 503) : json({ done: true }); },
    });
    assert.deepEqual(await busy.get('artist/a'), { done: true });
    assert.equal(attempts, 3);

    let badAttempts = 0;
    const bad = new MusicBrainzClient({ contact: 'x', sleep: async () => {}, fetchImpl: async () => { badAttempts += 1; return json({}, 400); } });
    await assert.rejects(bad.get('artist/a'));
    assert.equal(badAttempts, 1);
  });

  it('escapes search syntax in names', () => {
    assert.equal(escapeLucene('AC/DC: "Back"'), 'AC\\/DC\\: \\"Back\\"');
  });
});
