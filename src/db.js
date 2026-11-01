import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Search rows use rowid = id * 4 + kind, so a row can be replaced without scanning the index.
const MIGRATIONS = [
  `
  CREATE TABLE artists (
    id INTEGER PRIMARY KEY,
    mbid TEXT UNIQUE,
    name TEXT NOT NULL,
    country TEXT,
    artist_type TEXT,
    begin_year INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE albums (
    id INTEGER PRIMARY KEY,
    mbid TEXT UNIQUE,
    title TEXT NOT NULL,
    artist_id INTEGER NOT NULL REFERENCES artists(id),
    artist_credit TEXT NOT NULL,
    release_date TEXT,
    album_type TEXT,
    cover_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX albums_artist ON albums(artist_id);
  CREATE INDEX albums_release ON albums(release_date DESC);
  CREATE TABLE songs (
    id INTEGER PRIMARY KEY,
    mbid TEXT,
    title TEXT NOT NULL,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_id INTEGER NOT NULL REFERENCES artists(id),
    artist_credit TEXT NOT NULL,
    disc INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL,
    duration_ms INTEGER,
    UNIQUE (album_id, disc, position)
  );
  CREATE INDEX songs_artist ON songs(artist_id);
  CREATE TABLE genres (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
  );
  CREATE TABLE artist_genres (
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (artist_id, genre_id)
  ) WITHOUT ROWID;
  CREATE TABLE album_genres (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, genre_id)
  ) WITHOUT ROWID;
  CREATE INDEX album_genres_genre ON album_genres(genre_id);
  CREATE INDEX artist_genres_genre ON artist_genres(genre_id);

  CREATE VIRTUAL TABLE search_index USING fts5(
    kind UNINDEXED, ref_id UNINDEXED, name, context,
    tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
  );
  CREATE TRIGGER artists_ai AFTER INSERT ON artists BEGIN
    INSERT INTO search_index(rowid, kind, ref_id, name, context)
    VALUES (new.id * 4, 'artist', new.id, new.name, '');
  END;
  CREATE TRIGGER albums_ai AFTER INSERT ON albums BEGIN
    INSERT INTO search_index(rowid, kind, ref_id, name, context)
    VALUES (new.id * 4 + 1, 'album', new.id, new.title, new.artist_credit);
  END;
  CREATE TRIGGER songs_ai AFTER INSERT ON songs BEGIN
    INSERT INTO search_index(rowid, kind, ref_id, name, context)
    VALUES (new.id * 4 + 2, 'song', new.id, new.title, new.artist_credit);
  END;
  CREATE TRIGGER genres_ai AFTER INSERT ON genres BEGIN
    INSERT INTO search_index(rowid, kind, ref_id, name, context)
    VALUES (new.id * 4 + 3, 'genre', new.id, new.name, '');
  END;
  CREATE TRIGGER artists_ad AFTER DELETE ON artists BEGIN
    DELETE FROM search_index WHERE rowid = old.id * 4;
  END;
  CREATE TRIGGER albums_ad AFTER DELETE ON albums BEGIN
    DELETE FROM search_index WHERE rowid = old.id * 4 + 1;
  END;
  CREATE TRIGGER songs_ad AFTER DELETE ON songs BEGIN
    DELETE FROM search_index WHERE rowid = old.id * 4 + 2;
  END;
  CREATE TRIGGER genres_ad AFTER DELETE ON genres BEGIN
    DELETE FROM search_index WHERE rowid = old.id * 4 + 3;
  END;

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX sessions_expiry ON sessions(expires_at);

  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic_type TEXT NOT NULL CHECK (topic_type IN ('album', 'song', 'artist', 'genre')),
    topic_id INTEGER NOT NULL,
    tab TEXT NOT NULL CHECK (tab IN ('story', 'concert', 'tips', 'rating')),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    rating INTEGER CHECK (rating BETWEEN 0 AND 10),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at TEXT,
    CHECK ((tab = 'rating') = (rating IS NOT NULL))
  );
  CREATE INDEX posts_topic ON posts(topic_type, topic_id, tab, id DESC);
  CREATE INDEX posts_user ON posts(user_id, id DESC);
  CREATE UNIQUE INDEX one_rating_per_topic ON posts(user_id, topic_type, topic_id) WHERE tab = 'rating';

  CREATE TABLE import_queue (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('artist', 'search')),
    term TEXT NOT NULL,
    term_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    UNIQUE (kind, term_key)
  );
  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    albums_added INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  `,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
