import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Client, seedCatalog, startApp } from './helpers.js';

let app;
let ids;
let counter = 0;
const uniqueName = () => { counter += 1; return `listener_${counter}`; };

before(async () => {
  app = await startApp();
  ids = seedCatalog(app.db);
});
after(() => app.close());

async function signedIn() {
  const client = new Client(app.base);
  const result = await client.signup(uniqueName());
  assert.equal(result.status, 303, result.text);
  return client;
}

const post = (client, fields) => client.post('/posts', { topic_type: 'album', topic_id: ids.album, tab: 'story', body: 'A memory', ...fields });

describe('search', () => {
  it('finds each kind of topic, ignoring accents and case', async () => {
    const client = new Client(app.base);
    for (const [q, expected] of [['midnight', 'Midnight Signal'], ['paper cr', 'Paper Crown'], ['BEYONCE', 'Beyoncé Test Band'], ['dream', 'dream pop']]) {
      const { text } = await client.get(`/search?q=${encodeURIComponent(q)}`);
      assert.ok(text.includes(expected), `${q} should find ${expected}`);
    }
  });

  it('filters by kind and survives search operators', async () => {
    const client = new Client(app.base);
    const filtered = await client.get('/search?q=paper&type=album');
    assert.ok(filtered.text.includes('Nothing in the library matches'));
    for (const q of ['"', 'AND OR NOT', '*', 'a:b', '(((', 'NEAR(']) {
      assert.equal((await client.get(`/search?q=${encodeURIComponent(q)}`)).status, 200, q);
    }
  });

  it('suggests matches as JSON', async () => {
    const { text } = await new Client(app.base).get('/api/suggest?q=mid');
    assert.deepEqual(JSON.parse(text).items[0], { kind: 'album', name: 'Midnight Signal', context: 'Album by Beyoncé Test Band', cover: null, url: `/albums/${ids.album}` });
  });
});

describe('topic pages', () => {
  it('opens every topic type with all four conversation tabs', async () => {
    const client = new Client(app.base);
    for (const path of [`/albums/${ids.album}`, `/songs/${ids.song}`, `/artists/${ids.artist}`, '/genres/dream-pop']) {
      const { status, text } = await client.get(path);
      assert.equal(status, 200, path);
      for (const label of ['Personal stories', 'Concerts', 'Performance tips', 'Ratings']) assert.ok(text.includes(label), `${path} ${label}`);
      assert.match(text, /aria-current="page">\s*<span class="tab-label">Personal stories/);
    }
  });

  it('returns 404 for unknown topics', async () => {
    const client = new Client(app.base);
    assert.equal((await client.get('/albums/99999')).status, 404);
    assert.equal((await client.get('/genres/nope')).status, 404);
    assert.equal((await client.get('/nope')).status, 404);
  });

  it('keeps posts in the tab and topic they were written for', async () => {
    const client = await signedIn();
    await post(client, { tab: 'concert', body: 'Front row at the Fillmore' });
    const concert = await client.get(`/albums/${ids.album}?tab=concert`);
    const tips = await client.get(`/albums/${ids.album}?tab=tips`);
    const song = await client.get(`/songs/${ids.song}?tab=concert`);
    assert.ok(concert.text.includes('Front row at the Fillmore'));
    assert.ok(!tips.text.includes('Front row at the Fillmore'));
    assert.ok(!song.text.includes('Front row at the Fillmore'));
  });
});

describe('accounts', () => {
  it('signs up, logs out, and logs back in', async () => {
    const client = new Client(app.base);
    const username = uniqueName();
    assert.equal((await client.signup(username)).status, 303);
    assert.ok((await client.get('/')).text.includes(`/u/${username}`));
    await client.post('/logout');
    assert.ok(!(await client.get('/')).text.includes(`/u/${username}`));
    const bad = await client.post('/login', { email: `${username}@example.com`, password: 'wrong-password-here' });
    assert.equal(bad.status, 422);
    const good = await client.post('/login', { email: `${username.toUpperCase()}@EXAMPLE.COM`.toLowerCase(), password: 'correct-horse-battery' });
    assert.equal(good.status, 303);
    assert.ok((await client.get('/')).text.includes(`/u/${username}`));
  });

  it('stores only hashes of passwords and session tokens', async () => {
    const client = await signedIn();
    const dump = JSON.stringify(app.db.prepare('SELECT password_hash FROM users').all()) + JSON.stringify(app.db.prepare('SELECT token_hash FROM sessions').all());
    assert.ok(!dump.includes('correct-horse-battery'));
    assert.ok(!dump.includes(client.cookies.get('tb_session')));
  });

  it('rejects weak passwords, bad names, and duplicates regardless of case', async () => {
    const client = new Client(app.base);
    assert.equal((await client.post('/signup', { username: 'ok_name', email: 'ok@example.com', password: 'short' })).status, 422);
    assert.equal((await client.post('/signup', { username: 'x', email: 'ok@example.com', password: 'long-enough-password' })).status, 422);
    assert.equal((await client.post('/signup', { username: 'Twin_Name', email: 'twin@example.com', password: 'long-enough-password' })).status, 303);
    const other = new Client(app.base);
    assert.equal((await other.post('/signup', { username: 'twin_name', email: 'twin2@example.com', password: 'long-enough-password' })).status, 422);
    assert.equal((await other.post('/signup', { username: 'twin3', email: 'TWIN@example.com', password: 'long-enough-password' })).status, 422);
  });

  it('only redirects to paths on this site after login', async () => {
    const client = new Client(app.base);
    const name = uniqueName();
    const result = await client.post('/signup', { username: name, email: `${name}@example.com`, password: 'long-enough-password', next: '//evil.example' });
    assert.equal(result.location, '/');
  });

  it('locks out repeated login attempts for an account', async () => {
    const client = new Client(app.base);
    let last;
    for (let i = 0; i < 11; i += 1) last = await client.post('/login', { email: 'target@example.com', password: 'guess-number-one' }, { headers: {} });
    assert.equal(last.status, 429);
  });
});

describe('posting rules', () => {
  it('requires an account', async () => {
    const result = await post(new Client(app.base), {});
    assert.equal(result.status, 303);
    assert.match(result.location, /^\/login/);
  });

  it('rejects forged requests', async () => {
    const client = await signedIn();
    assert.equal((await post(client, { _csrf: 'wrong' })).status, 403);
    const crossSite = await client.post('/posts', { topic_type: 'album', topic_id: ids.album, tab: 'story', body: 'x' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  });

  it('accepts ratings from 0 to 10 and nothing else', async () => {
    for (const value of ['0', '10']) {
      const client = await signedIn();
      assert.equal((await post(client, { tab: 'rating', rating: value, body: 'Opinion' })).status, 303, value);
    }
    const client = await signedIn();
    for (const value of ['11', '-1', '7.5', 'abc', '']) {
      assert.equal((await post(client, { tab: 'rating', rating: value, body: 'Opinion' })).status, 422, value);
    }
  });

  it('needs a rating in the rating tab, and ignores one elsewhere', async () => {
    const client = await signedIn();
    assert.equal((await post(client, { tab: 'rating', body: 'No score' })).status, 422);
    assert.equal((await post(client, { tab: 'tips', rating: '9', body: 'Use a capo' })).status, 303);
    const row = app.db.prepare(`SELECT rating FROM posts WHERE body = 'Use a capo'`).get();
    assert.equal(row.rating, null);
  });

  it('averages ratings and allows one per person per topic', async () => {
    const before = app.db.prepare('SELECT count(*) AS n FROM posts WHERE topic_type = ? AND topic_id = ?').get('song', ids.song).n;
    const rate = (client, rating) => client.post('/posts', { topic_type: 'song', topic_id: ids.song, tab: 'rating', rating, body: 'Thoughts' });
    const first = await signedIn();
    const second = await signedIn();
    await rate(first, '4');
    await rate(first, '10');
    await rate(second, '9');
    const count = app.db.prepare('SELECT count(*) AS n FROM posts WHERE topic_type = ? AND topic_id = ?').get('song', ids.song).n;
    assert.equal(count - before, 2);
    const { text } = await first.get(`/songs/${ids.song}?tab=rating`);
    assert.ok(text.includes('Average rating 6.5 out of 10'), 'average of 4 and 9');
    assert.ok(text.includes('Edit your rating'));
  });

  it('escapes what users write', async () => {
    const client = await signedIn();
    await post(client, { tab: 'tips', body: '<script>alert(1)</script><img src=x onerror=alert(2)>' });
    const { text, response } = await client.get(`/albums/${ids.album}?tab=tips`);
    assert.ok(!text.includes('<script>alert(1)'));
    assert.ok(!text.includes('<img src=x'));
    assert.ok(text.includes('&lt;script&gt;alert(1)'));
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  });

  it('rejects empty and oversized posts but keeps what was typed', async () => {
    const client = await signedIn();
    assert.equal((await post(client, { body: '    ' })).status, 422);
    const long = await post(client, { body: 'x'.repeat(5001) });
    assert.equal(long.status, 422);
    assert.ok(long.text.includes('xxxxx'));
    assert.equal((await post(client, { body: 'x'.repeat(70000) })).status, 413);
  });

  it('lets only the author edit or delete a post', async () => {
    const author = await signedIn();
    const other = await signedIn();
    const created = await post(author, { body: 'Original words' });
    const id = created.location.match(/post-(\d+)/)[1];
    assert.equal((await other.post(`/posts/${id}/edit`, { body: 'Hijacked' })).status, 403);
    assert.equal((await other.post(`/posts/${id}/delete`)).status, 403);
    assert.equal((await author.post(`/posts/${id}/edit`, { body: 'Better words' })).status, 303);
    assert.equal(app.db.prepare('SELECT body FROM posts WHERE id = ?').get(id).body, 'Better words');
    assert.equal((await author.post(`/posts/${id}/delete`)).status, 303);
    assert.equal(app.db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id), undefined);
  });

  it('rejects posts for topics that do not exist', async () => {
    const client = await signedIn();
    assert.equal((await post(client, { topic_id: 99999 })).status, 404);
    assert.equal((await post(client, { topic_type: 'playlist' })).status, 400);
    assert.equal((await post(client, { tab: 'gossip' })).status, 400);
  });

  it('limits how fast one person can post', async () => {
    const client = await signedIn();
    let last;
    for (let i = 0; i < 21; i += 1) last = await post(client, { body: `Post ${i}` });
    assert.equal(last.status, 429);
  });
});

describe('home page', () => {
  it('asks for the story behind your song', async () => {
    const { text } = await new Client(app.base).get('/');
    assert.ok(text.includes("What's the story behind your song?"));
  });
});

describe('browser caching', () => {
  it('gives files a fingerprinted URL, so an update reaches browsers right away', async () => {
    const client = new Client(app.base);
    const { text } = await client.get('/');
    const url = text.match(/href="(\/styles\.css\?v=[0-9a-f]{12})"/)?.[1];
    assert.ok(url, 'stylesheet URL has a fingerprint');
    assert.match(text, /src="\/app\.js\?v=[0-9a-f]{12}"/);
    assert.match((await client.request(url)).headers.get('cache-control'), /immutable/);
    assert.equal((await client.request('/styles.css')).headers.get('cache-control'), 'no-cache');
    assert.equal((await client.request('/styles.css?v=old')).headers.get('cache-control'), 'no-cache');
  });
});

describe('library requests', () => {
  it('queues a missing search once and shows that it is pending', async () => {
    const client = await signedIn();
    assert.ok((await client.get('/search?q=Unknown%20Band')).text.includes('Add "Unknown Band" to the library'));
    await client.post('/catalog/request', { q: 'Unknown Band' });
    await client.post('/catalog/request', { q: 'unknown band' });
    assert.equal(app.db.prepare(`SELECT count(*) AS n FROM import_queue WHERE term_key = 'unknown band'`).get().n, 1);
    assert.ok((await client.get('/search?q=Unknown%20Band')).text.includes('Looking for'));
  });
});
