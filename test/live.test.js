import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { Importer } from '../src/importer.js';
import { LiveSearch, buildLiveQuery } from '../src/live-search.js';
import { MusicBrainzClient } from '../src/musicbrainz.js';
import { Client } from './helpers.js';

const ARTIST = 'a1111111-1111-4111-8111-111111111111';
const GROUP = 'b2222222-2222-4222-8222-222222222222';
const RECORDING = 'c3333333-3333-4333-8333-333333333333';
const COMPILATION = 'd4444444-4444-4444-8444-444444444444';
const credit = [{ name: 'Radio Test', artist: { id: ARTIST, name: 'Radio Test' } }];

function fakeMb() {
  const calls = [];
  const groupFor = (id) => ({ id, title: id === COMPILATION ? 'Greatest Hits' : 'Kid Test', 'primary-type': 'Album', 'secondary-types': id === COMPILATION ? ['Compilation'] : [], 'first-release-date': '2000-10-02', 'artist-credit': credit, genres: [{ name: 'art rock', count: 2 }] });
  return {
    calls,
    interactiveWaiting: 0,
    searchArtists: async (query) => { calls.push(`artists:${query}`); return { artists: [{ id: 'other', name: 'Radio Testers', type: 'Group' }, { id: ARTIST, name: 'Radio Test', type: 'Group', country: 'GB', score: 100 }] }; },
    searchReleaseGroups: async () => ({ 'release-groups': [
      { id: COMPILATION, title: 'Greatest Hits', 'primary-type': 'Album', 'secondary-types': ['Compilation'], 'artist-credit': credit },
      { id: GROUP, title: 'Kid Test', 'primary-type': 'Album', 'artist-credit': credit },
      { id: 'same', title: 'Kid Test', 'primary-type': 'Album', 'artist-credit': credit },
    ] }),
    searchRecordings: async () => ({ recordings: [{ id: RECORDING, title: 'Everything Test', 'artist-credit': credit, releases: [
      { 'release-group': { id: COMPILATION, 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
      { 'release-group': { id: GROUP, 'primary-type': 'Album' } },
    ] }, { id: 'no-release', title: 'Loose Take', 'artist-credit': credit }] }),
    lookupArtist: async (id) => { calls.push(`lookupArtist:${id}`); return { id, name: 'Radio Test', type: 'Group', genres: [] }; },
    lookupReleaseGroup: async (id) => { calls.push(`lookupGroup:${id}`); return groupFor(id); },
    browseReleases: async () => ({ releases: [{ date: '2000-10-02', media: [{ position: 1, tracks: [{ position: 1, title: 'Everything Test', length: 251000, recording: { id: RECORDING } }, { position: 2, title: 'Other Song', recording: { id: 'rec-2' } }] }] }] }),
    browseArtistReleaseGroups: async () => ({ 'release-groups': [] }),
  };
}

describe('building the search', () => {
  it('treats the last word as unfinished and keeps names safe', () => {
    assert.equal(buildLiveQuery('artist', 'Taylor Sw'), 'artist:"taylor sw"^4 OR artist:(taylor AND sw*)');
    assert.equal(buildLiveQuery('artist', 'AC/DC'), 'artist:"ac\\/dc"^4 OR artist:(ac\\/dc*)');
    assert.equal(buildLiveQuery('artist', '   '), null);
  });
});

describe('live search', () => {
  it('puts the closest name first and skips compilations and duplicates', async () => {
    const live = new LiveSearch(openDb(':memory:'), fakeMb());
    assert.deepEqual((await live.search('artist', 'radio test')).map((item) => item.name), ['Radio Test', 'Radio Testers']);
    const albums = await live.search('album', 'kid');
    assert.deepEqual(albums.map((item) => item.name), ['Kid Test']);
    assert.equal(albums[0].url, `/open/album/${GROUP}`);
    const songs = await live.search('song', 'everything');
    assert.deepEqual(songs.map((item) => item.url), [`/open/song/${RECORDING}/${GROUP}`]);
  });

  it('answers repeat searches from memory, and expires them', async () => {
    let now = 0;
    const mb = fakeMb();
    const live = new LiveSearch(openDb(':memory:'), mb, { now: () => now });
    await live.search('artist', 'Radio');
    await live.search('artist', 'radio ');
    assert.equal(mb.calls.length, 1);
    now = 11 * 60000;
    await live.search('artist', 'radio');
    assert.equal(mb.calls.length, 2);
  });

  it('does nothing for one letter, or when too many people are waiting', async () => {
    const mb = fakeMb();
    const live = new LiveSearch(openDb(':memory:'), mb);
    assert.deepEqual(await live.search('artist', 'r'), []);
    mb.interactiveWaiting = 50;
    assert.deepEqual(await live.search('artist', 'radio'), []);
    assert.equal(mb.calls.length, 0);
  });
});

describe('opening a result', () => {
  let db; let mb; let server; let base;
  before(async () => {
    db = openDb(':memory:');
    mb = fakeMb();
    const config = { secureCookies: false, trustProxy: false, production: false };
    server = createServer(createApp({ db, config, importer: new Importer(db, mb), live: new LiveSearch(db, mb) }));
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

  it('adds a song and its album, then links straight to them', async () => {
    const client = new Client(base);
    const live = JSON.parse((await client.get('/api/live?kind=song&q=everything')).text).items[0];
    const opened = await client.request(live.url);
    assert.equal(opened.status, 303);
    const location = opened.headers.get('location');
    assert.match(location, /^\/songs\/\d+$/);
    assert.ok((await client.get(location)).text.includes('Everything Test'));
    const again = JSON.parse((await client.get('/api/live?kind=song&q=everything')).text).items[0];
    assert.equal(again.url, location);
    assert.equal(JSON.parse((await client.get('/api/suggest?q=everything')).text).items[0].url, location);
  });

  it('adds a compilation when someone asks for that exact one', async () => {
    const opened = await new Client(base).request(`/open/album/${COMPILATION}`);
    assert.match(opened.headers.get('location'), /^\/albums\/\d+$/);
  });

  it('adds an artist right away, and queues their albums once', async () => {
    const client = new Client(base);
    const opened = await client.request(`/open/artist/${ARTIST}`);
    assert.match(opened.headers.get('location'), /^\/artists\/\d+$/);
    await client.request(`/open/artist/${ARTIST}`);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM import_queue WHERE kind = 'artist_id'`).get().n, 1);
    assert.ok((await client.get(opened.headers.get('location'))).text.includes('Adding this artist'));
  });

  it('explains when MusicBrainz is down, and rejects bad IDs', async () => {
    const client = new Client(base);
    const original = mb.lookupReleaseGroup;
    mb.lookupReleaseGroup = async () => { throw new Error('offline'); };
    const failed = await client.get('/open/album/e5555555-5555-4555-8555-555555555555');
    mb.lookupReleaseGroup = original;
    assert.equal(failed.status, 503);
    assert.ok(failed.text.includes('Go back and try again'));
    assert.equal((await client.get('/open/album/not-an-id')).status, 404);
  });
});

describe('sharing the rate limit', () => {
  const json = (body) => new Response(JSON.stringify(body));

  it('lets a person go ahead of queued background imports', async () => {
    const order = [];
    const client = new MusicBrainzClient({
      contact: 'x', sleep: async () => {}, minIntervalMs: 0,
      fetchImpl: async (url) => { order.push(url.pathname.split('/').pop()); await new Promise((r) => { setTimeout(r, 5); }); return json({}); },
    });
    const all = [client.get('bg1'), client.get('bg2'), client.get('bg3'), client.get('person', {}, { priority: 'interactive' })];
    await Promise.all(all);
    assert.deepEqual(order, ['bg1', 'person', 'bg2', 'bg3']);
  });

  it('drops a search when the person has kept typing', async () => {
    const seen = [];
    const client = new MusicBrainzClient({ contact: 'x', sleep: async () => {}, minIntervalMs: 0, fetchImpl: async (url) => { seen.push(url.pathname); return json({}); } });
    const stop = new AbortController();
    const first = client.get('first');
    const stale = client.get('stale', {}, { priority: 'interactive', signal: stop.signal });
    stop.abort();
    await first;
    await assert.rejects(stale);
    assert.ok(!seen.some((path) => path.endsWith('stale')));
  });

  it('fails fast for a person instead of backing off', async () => {
    let attempts = 0;
    const client = new MusicBrainzClient({ contact: 'x', sleep: async () => {}, minIntervalMs: 0, fetchImpl: async () => { attempts += 1; return new Response('', { status: 503 }); } });
    await assert.rejects(client.get('busy', {}, { priority: 'interactive' }));
    assert.equal(attempts, 1);
  });
});

describe('upgrading an existing database', () => {
  it('keeps queued imports', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO import_queue (kind, term, term_key) VALUES ('artist_id', 'x', 'x')`).run();
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM import_queue').get().n, 1);
  });
});
