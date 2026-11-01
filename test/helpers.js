import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

export async function startApp() {
  const db = openDb(':memory:');
  const config = { secureCookies: false, trustProxy: false, production: false, signupLimitPerHour: 10000 };
  const server = createServer(createApp({ db, config }));
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

// A tiny browser: keeps cookies and fills in the form's CSRF token.
export class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  async request(path, options = {}) {
    const response = await fetch(this.base + path, {
      redirect: 'manual',
      ...options,
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const value = pair.slice(index + 1);
      if (value) this.cookies.set(pair.slice(0, index), value);
      else this.cookies.delete(pair.slice(0, index));
    }
    return response;
  }

  async get(path) {
    const response = await this.request(path);
    return { response, status: response.status, text: await response.text() };
  }

  async post(path, fields = {}, { csrf = true, headers = {} } = {}) {
    if (!this.cookies.has('tb_csrf')) await this.get('/login');
    const body = new URLSearchParams({ ...(csrf ? { _csrf: this.cookies.get('tb_csrf') } : {}), ...fields });
    const response = await this.request(path, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    return { response, status: response.status, text: await response.text(), location: response.headers.get('location') };
  }

  signup(username = 'listener_one', email = `${username}@example.com`, password = 'correct-horse-battery') {
    return this.post('/signup', { username, email, password });
  }
}

export function seedCatalog(db) {
  const artist = Number(db.prepare(`INSERT INTO artists (name, country) VALUES ('Beyoncé Test Band', 'US')`).run().lastInsertRowid);
  const album = Number(db.prepare(`INSERT INTO albums (title, artist_id, artist_credit, release_date, album_type) VALUES ('Midnight Signal', ?, 'Beyoncé Test Band', '2026-10-01', 'Album')`).run(artist).lastInsertRowid);
  const song = Number(db.prepare(`INSERT INTO songs (title, album_id, artist_id, artist_credit, position, duration_ms) VALUES ('Paper Crown', ?, ?, 'Beyoncé Test Band', 1, 201000)`).run(album, artist).lastInsertRowid);
  const genre = Number(db.prepare(`INSERT INTO genres (name, slug) VALUES ('dream pop', 'dream-pop')`).run().lastInsertRowid);
  db.prepare('INSERT INTO album_genres VALUES (?, ?)').run(album, genre);
  db.prepare('INSERT INTO artist_genres VALUES (?, ?)').run(artist, genre);
  return { artist, album, song, genre };
}
