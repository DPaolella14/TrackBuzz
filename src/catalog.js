export const TOPIC_TYPES = ['album', 'song', 'artist', 'genre'];

export function slugify(name) {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'genre';
}

export function topicUrl(topic, tab) {
  const base = {
    album: `/albums/${topic.id}`,
    song: `/songs/${topic.id}`,
    artist: `/artists/${topic.id}`,
    genre: `/genres/${encodeURIComponent(topic.slug)}`,
  }[topic.type];
  return tab ? `${base}?tab=${tab}` : base;
}

export function getTopic(db, type, id) {
  const queries = {
    album: `SELECT albums.id, title AS name, artist_id, artist_credit, release_date, album_type, cover_url
            FROM albums WHERE albums.id = ?`,
    song: `SELECT songs.id, songs.title AS name, songs.artist_id, songs.artist_credit, songs.duration_ms,
                  songs.album_id, albums.title AS album_title, albums.cover_url, albums.release_date
           FROM songs JOIN albums ON albums.id = songs.album_id WHERE songs.id = ?`,
    artist: 'SELECT id, name, country, artist_type, begin_year FROM artists WHERE id = ?',
    genre: 'SELECT id, name, slug FROM genres WHERE id = ?',
  };
  if (!queries[type]) return null;
  const row = db.prepare(queries[type]).get(id);
  return row ? { ...row, type } : null;
}

export function getGenreBySlug(db, slug) {
  const row = db.prepare('SELECT id, name, slug FROM genres WHERE slug = ?').get(slug);
  return row ? { ...row, type: 'genre' } : null;
}

export function buildSearchQuery(text) {
  const tokens = String(text).normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.slice(0, 8).map((token) => `"${token}"*`).join(' ');
}

function hydrate(db, row) {
  const topic = getTopic(db, row.kind, Number(row.ref_id));
  return topic;
}

export function search(db, text, { kind = null, limit = 24, offset = 0 } = {}) {
  const match = buildSearchQuery(text);
  if (!match) return { items: [], counts: {}, hasMore: false };
  const counts = {};
  for (const row of db.prepare('SELECT kind, count(*) AS total FROM search_index WHERE search_index MATCH ? GROUP BY kind').all(match)) {
    counts[row.kind] = row.total;
  }
  const rows = db.prepare(`
    SELECT kind, ref_id FROM search_index
    WHERE search_index MATCH ? AND (? IS NULL OR kind = ?)
    ORDER BY (lower(name) = lower(?)) DESC,
             CASE kind WHEN 'artist' THEN 0 WHEN 'genre' THEN 1 WHEN 'album' THEN 2 ELSE 3 END,
             bm25(search_index, 0, 0, 10, 1)
    LIMIT ? OFFSET ?
  `).all(match, kind, kind, String(text).trim(), limit + 1, offset);
  return {
    items: rows.slice(0, limit).map((row) => hydrate(db, row)).filter(Boolean),
    counts,
    hasMore: rows.length > limit,
  };
}

const SONG_LIST = `SELECT songs.id, songs.title AS name, songs.artist_id, songs.artist_credit, songs.duration_ms,
  songs.album_id, songs.disc, songs.position, albums.title AS album_title, albums.cover_url, albums.release_date, 'song' AS type
  FROM songs JOIN albums ON albums.id = songs.album_id`;
const ALBUM_LIST = `SELECT albums.id, albums.title AS name, albums.artist_id, albums.artist_credit, albums.release_date,
  albums.album_type, albums.cover_url, 'album' AS type FROM albums`;

const page = (rows, limit) => ({ items: rows.slice(0, limit), hasMore: rows.length > limit });

export function listAlbums(db, { limit = 24, offset = 0 } = {}) {
  return page(db.prepare(`${ALBUM_LIST} ORDER BY release_date IS NULL, release_date DESC, albums.id DESC LIMIT ? OFFSET ?`).all(limit + 1, offset), limit);
}

export function listSongs(db, { limit = 40, offset = 0 } = {}) {
  return page(db.prepare(`${SONG_LIST} ORDER BY albums.release_date IS NULL, albums.release_date DESC, songs.album_id DESC, songs.disc, songs.position LIMIT ? OFFSET ?`).all(limit + 1, offset), limit);
}

export function listArtists(db, { limit = 48, offset = 0 } = {}) {
  return page(db.prepare(`SELECT id, name, country, artist_type, begin_year, 'artist' AS type FROM artists ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`).all(limit + 1, offset), limit);
}

export function listGenres(db, { limit = 120, offset = 0 } = {}) {
  return page(db.prepare(`
    SELECT genres.id, genres.name, genres.slug, 'genre' AS type, count(album_genres.album_id) AS album_count
    FROM genres LEFT JOIN album_genres ON album_genres.genre_id = genres.id
    GROUP BY genres.id ORDER BY album_count DESC, genres.name LIMIT ? OFFSET ?
  `).all(limit + 1, offset), limit);
}

export function albumSongs(db, albumId) {
  return db.prepare(`${SONG_LIST} WHERE songs.album_id = ? ORDER BY songs.disc, songs.position`).all(albumId);
}

export function artistAlbums(db, artistId) {
  return db.prepare(`${ALBUM_LIST} WHERE albums.artist_id = ? ORDER BY release_date IS NULL, release_date DESC LIMIT 60`).all(artistId);
}

export function genreAlbums(db, genreId, limit = 24) {
  return db.prepare(`${ALBUM_LIST} JOIN album_genres ON album_genres.album_id = albums.id
    WHERE album_genres.genre_id = ? ORDER BY release_date IS NULL, release_date DESC LIMIT ?`).all(genreId, limit);
}

export function genreArtists(db, genreId, limit = 24) {
  return db.prepare(`SELECT artists.id, artists.name, 'artist' AS type FROM artists
    JOIN artist_genres ON artist_genres.artist_id = artists.id
    WHERE artist_genres.genre_id = ? ORDER BY artists.name COLLATE NOCASE LIMIT ?`).all(genreId, limit);
}

export function topicGenres(db, type, id) {
  const sql = {
    artist: 'SELECT genres.id, genres.name, genres.slug, \'genre\' AS type FROM genres JOIN artist_genres ON genre_id = genres.id WHERE artist_id = ? ORDER BY genres.name',
    album: 'SELECT genres.id, genres.name, genres.slug, \'genre\' AS type FROM genres JOIN album_genres ON genre_id = genres.id WHERE album_id = ? ORDER BY genres.name',
  }[type];
  return sql ? db.prepare(sql).all(id) : [];
}

export function ensureGenre(db, name) {
  const clean = name.trim().toLowerCase();
  if (!clean) return null;
  const existing = db.prepare('SELECT id FROM genres WHERE name = ?').get(clean);
  if (existing) return existing.id;
  let slug = slugify(clean);
  if (db.prepare('SELECT 1 FROM genres WHERE slug = ?').get(slug)) slug = `${slug}-${Date.now().toString(36)}`;
  return Number(db.prepare('INSERT INTO genres (name, slug) VALUES (?, ?)').run(clean, slug).lastInsertRowid);
}
