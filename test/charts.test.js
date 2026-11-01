import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chartsDue, homeCharts, refreshCharts } from '../src/charts.js';
import { getTopic, listArtists } from '../src/catalog.js';
import { openDb } from '../src/db.js';
import { Client, startApp } from './helpers.js';

const payloads = {
  artists: { artists: [{ artist_name: 'Hit Band', artist_mbid: 'artist-a', listen_count: 9 }, { artist_name: 'No ID' }] },
  'release-groups': { release_groups: [{ release_group_name: 'Hit Album', release_group_mbid: 'group-a', artist_name: 'Hit Band', caa_id: 1, caa_release_mbid: 'x' }] },
  recordings: { recordings: [{ track_name: 'Hit Song', artist_name: 'Hit Band', recording_mbid: 'rec-a', release_mbid: 'rel-a' }, { track_name: 'No ID', artist_name: 'x' }] },
};
const respondWith = (urls = []) => async (url) => {
  urls.push(url);
  const kind = url.match(/sitewide\/([a-z-]+)/)[1];
  return new Response(JSON.stringify({ payload: payloads[kind] }));
};

describe('popular music', () => {
  it('stores each chart and moves popular music to the front of the import line', async () => {
    const db = openDb(':memory:');
    const urls = [];
    assert.equal(await refreshCharts(db, { fetchImpl: respondWith(urls) }), 3);
    assert.match(urls[0], /range=week/);
    const charts = homeCharts(db);
    assert.deepEqual(charts.artists.map((item) => item.url), ['/open/artist/artist-a']);
    assert.equal(charts.artists[0].cover_url, 'https://coverartarchive.org/release-group/group-a/front-250');
    assert.deepEqual(charts.albums.map((item) => item.url), ['/open/album/group-a']);
    assert.deepEqual(charts.songs.map((item) => [item.name, item.url, item.cover_url]), [['Hit Song', '/open/recording/rec-a', 'https://coverartarchive.org/release/rel-a/front-250']]);
    const queued = db.prepare('SELECT kind, term, round FROM import_queue ORDER BY kind').all().map((row) => ({ ...row }));
    assert.deepEqual(queued, [{ kind: 'album', term: 'group-a', round: -1 }, { kind: 'artist_id', term: 'artist-a', round: -1 }]);
    assert.equal(chartsDue(db), false);
    assert.equal(chartsDue(db, Date.now() + 25 * 3600000), true);
  });

  it('uses a longer period when the latest is not ready, and keeps old charts on empty data', async () => {
    const db = openDb(':memory:');
    await refreshCharts(db, { fetchImpl: respondWith() });
    const urls = [];
    await refreshCharts(db, { fetchImpl: async (url) => { urls.push(url); return new Response(null, { status: 204 }); } });
    assert.equal(urls.filter((url) => url.includes('sitewide/artists')).length, 3);
    assert.equal(homeCharts(db).artists.length, 1);
  });

  it('reports a ListenBrainz failure to the caller', async () => {
    await assert.rejects(refreshCharts(openDb(':memory:'), { fetchImpl: async () => new Response('', { status: 500 }) }));
  });

  it('links to pages already on the site', async () => {
    const db = openDb(':memory:');
    await refreshCharts(db, { fetchImpl: respondWith() });
    const artist = Number(db.prepare(`INSERT INTO artists (mbid, name) VALUES ('artist-a', 'Hit Band')`).run().lastInsertRowid);
    const album = Number(db.prepare(`INSERT INTO albums (mbid, title, artist_id, artist_credit) VALUES ('group-a', 'Hit Album', ?, 'Hit Band')`).run(artist).lastInsertRowid);
    const song = Number(db.prepare(`INSERT INTO songs (mbid, title, album_id, artist_id, artist_credit, position) VALUES ('rec-a', 'Hit Song', ?, ?, 'Hit Band', 1)`).run(album, artist).lastInsertRowid);
    const charts = homeCharts(db);
    assert.equal(charts.artists[0].url, `/artists/${artist}`);
    assert.equal(charts.albums[0].url, `/albums/${album}`);
    assert.equal(charts.songs[0].url, `/songs/${song}`);
  });

  it('appears on the home page', async () => {
    const app = await startApp();
    try {
      await refreshCharts(app.db, { fetchImpl: respondWith() });
      const { text } = await new Client(app.base).get('/');
      for (const heading of ['Popular artists', 'Popular songs', 'Popular albums', 'Hit Song']) assert.ok(text.includes(heading), heading);
    } finally {
      await app.close();
    }
  });
});

describe('artist pictures', () => {
  it('uses the earliest studio album that has a cover', () => {
    const db = openDb(':memory:');
    const artist = Number(db.prepare(`INSERT INTO artists (name) VALUES ('Band')`).run().lastInsertRowid);
    const add = db.prepare('INSERT INTO albums (title, artist_id, artist_credit, release_date, album_type, cover_url) VALUES (?, ?, ?, ?, ?, ?)');
    add.run('Early EP', artist, 'Band', '1990', 'EP', 'ep.jpg');
    add.run('Later Album', artist, 'Band', '2000', 'Album', 'later.jpg');
    add.run('First Album', artist, 'Band', '1995', 'Album', 'first.jpg');
    assert.equal(getTopic(db, 'artist', artist).cover_url, 'first.jpg');
    assert.equal(listArtists(db).items[0].cover_url, 'first.jpg');
  });
});
