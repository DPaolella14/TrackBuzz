export const TOPIC_TYPES = ['album', 'song', 'artist', 'genre'];

// An artist's picture is the cover of their earliest studio album.
const ARTIST_PICTURE = `(SELECT cover_url FROM albums WHERE albums.artist_id = artists.id AND cover_url IS NOT NULL
  ORDER BY (album_type = 'Album') DESC, release_date IS NULL, release_date LIMIT 1) AS cover_url`;

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
    artist: `SELECT id, mbid, name, country, artist_type, begin_year, ${ARTIST_PICTURE} FROM artists WHERE id = ?`,
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

const KIND_ORDER = { artist: 0, genre: 1, album: 2, song: 3 };
const CANDIDATES_PER_KIND = 100;

const wordsIn = (text) => String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// The last word may still be being typed, so it matches as a prefix. A single letter would mean reading
// most of the index, so it's left out here, and search() checks it against the results instead.
export function buildSearchQuery(text, { wholeWords = false } = {}) {
  const tokens = wordsIn(text).slice(0, 8);
  const parts = tokens.map((token, index) => {
    if (token.length > 1) return index === tokens.length - 1 && !wholeWords ? `"${token}"*` : `"${token}"`;
    return index === tokens.length - 1 ? null : `"${token}"`;
  }).filter(Boolean);
  if (!parts.length) return null;
  return `{name context} : (${parts.join(' AND ')})`;
}

export function isFullCatalog(db) {
  return Boolean(db.prepare(`SELECT 1 FROM app_state WHERE key = 'full_import_at'`).get());
}

const fold = (text) => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function exactMatches(db, text, kind) {
  const found = [];
  if (!kind || kind === 'artist') {
    found.push(...db.prepare(`SELECT 'artist' AS kind, id AS ref_id, name FROM artists WHERE name = ? COLLATE NOCASE ORDER BY popularity DESC LIMIT 5`).all(text));
  }
  if (!kind || kind === 'album') {
    found.push(...db.prepare(`SELECT 'album' AS kind, id AS ref_id, title AS name FROM albums WHERE title = ? COLLATE NOCASE ORDER BY popularity DESC LIMIT 5`).all(text));
  }
  return found;
}

const lastWordIsLong = (typed) => typed[typed.length - 1].length > 3;

// With one letter typed so far, show the most popular artists and albums that start with it.
function firstLetterMatches(db, letter, kind, limit) {
  const like = `${letter}%`;
  const rows = [];
  if (!kind || kind === 'artist') rows.push(...db.prepare(`SELECT 'artist' AS kind, id AS ref_id, name FROM artists WHERE name LIKE ? ORDER BY popularity DESC LIMIT ?`).all(like, limit));
  if (!kind || kind === 'album') rows.push(...db.prepare(`SELECT 'album' AS kind, id AS ref_id, title AS name FROM albums WHERE title LIKE ? ORDER BY popularity DESC LIMIT ?`).all(like, limit));
  return rows;
}

// Each kind is searched separately, so popular songs can't crowd out an artist or album.
export function search(db, text, { kind = null, limit = 24, offset = 0 } = {}) {
  const clean = String(text).trim();
  const typed = wordsIn(clean);
  if (!typed.length) return { items: [], hasMore: false };
  if (typed.length === 1 && typed[0].length === 1) {
    const rows = firstLetterMatches(db, typed[0], kind, offset + limit + 1);
    return {
      items: rows.slice(offset, offset + limit).map((row) => getTopic(db, row.kind, Number(row.ref_id))).filter(Boolean),
      hasMore: rows.length > offset + limit,
    };
  }
  const match = buildSearchQuery(clean);
  if (!match) return { items: [], hasMore: false };
  const statement = db.prepare('SELECT kind, ref_id, name FROM search_index WHERE search_index MATCH ? LIMIT ?');
  const kinds = kind ? [kind] : Object.keys(KIND_ORDER);
  const want = Math.max(CANDIDATES_PER_KIND, offset + limit + 1);
  const rows = [...exactMatches(db, clean, kind)];
  // Reading one whole word stops early. A long prefix has to gather every word that starts with it first,
  // so it only runs when whole words didn't find enough.
  const wholeMatch = lastWordIsLong(typed) ? buildSearchQuery(clean, { wholeWords: true }) : null;
  kinds.forEach((one) => {
    const whole = wholeMatch ? statement.all(`kind : ${one} AND (${wholeMatch})`, want) : [];
    rows.push(...whole);
    if (whole.length < want) rows.push(...statement.all(`kind : ${one} AND (${match})`, want));
  });
  const target = fold(clean);
  const words = target.match(/[\p{L}\p{N}]+/gu) || [];
  const closeness = (name) => {
    const folded = fold(name);
    if (folded === target) return 0;
    if (folded.startsWith(target)) return 1;
    if (words.every((word) => folded.includes(word))) return 2;
    return 3;
  };
  // A single unfinished letter at the end still has to start a word.
  const lastWord = typed[typed.length - 1];
  const startsLastWord = (row) => {
    if (lastWord.length > 1) return true;
    const foldedLetter = fold(lastWord);
    return (fold(row.name).match(/[\p{L}\p{N}]+/gu) || []).some((word) => word.startsWith(foldedLetter));
  };
  const seen = new Set();
  const ranked = rows.filter((row) => {
    const key = `${row.kind}:${row.ref_id}`;
    if (seen.has(key) || !startsLastWord(row)) return false;
    seen.add(key);
    return true;
  }).map((row, index) => ({ row, index, close: closeness(row.name) }))
    .sort((a, b) => a.close - b.close || (a.close === 3 ? a.index - b.index : KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.index - b.index));
  return {
    items: ranked.slice(offset, offset + limit).map(({ row }) => getTopic(db, row.kind, Number(row.ref_id))).filter(Boolean),
    hasMore: ranked.length > offset + limit,
  };
}

const SONG_LIST = `SELECT songs.id, songs.title AS name, songs.artist_id, songs.artist_credit, songs.duration_ms,
  songs.album_id, songs.disc, songs.position, albums.title AS album_title, albums.cover_url, albums.release_date, 'song' AS type
  FROM songs JOIN albums ON albums.id = songs.album_id`;
const ALBUM_LIST = `SELECT albums.id, albums.title AS name, albums.artist_id, albums.artist_credit, albums.release_date,
  albums.album_type, albums.cover_url, 'album' AS type FROM albums`;

const page = (rows, limit) => ({ items: rows.slice(0, limit), hasMore: rows.length > limit });

// Relevance means popularity: how many editions of an album exist, or of an artist's albums.
// Each order matches an index, so every page stays fast at full catalog size.
export const SORTS = {
  album: { relevance: 'Relevance', newest: 'Newest', name: 'A to Z' },
  artist: { relevance: 'Relevance', name: 'A to Z' },
  song: { relevance: 'Relevance', newest: 'Newest' },
};

export function listAlbums(db, { limit = 24, offset = 0, releasedOnly = false, sort = 'newest' } = {}) {
  const released = releasedOnly ? `WHERE release_date <= date('now')` : '';
  const order = {
    relevance: 'popularity DESC, albums.id',
    name: 'title COLLATE NOCASE, popularity DESC',
    newest: 'release_date DESC, albums.id DESC',
  }[sort] ?? 'release_date DESC, albums.id DESC';
  return page(db.prepare(`${ALBUM_LIST} ${released} ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit + 1, offset), limit);
}

export function listSongs(db, { limit = 40, offset = 0, sort = 'newest' } = {}) {
  const albumOrder = sort === 'relevance' ? 'albums.popularity DESC, albums.id' : 'albums.release_date DESC, albums.id DESC';
  return page(db.prepare(`SELECT songs.id, songs.title AS name, songs.artist_id, songs.artist_credit, songs.duration_ms, songs.album_id, songs.disc, songs.position,
      albums.title AS album_title, albums.cover_url, albums.release_date, 'song' AS type
    FROM albums CROSS JOIN songs ON songs.album_id = albums.id
    ORDER BY ${albumOrder}, songs.disc, songs.position LIMIT ? OFFSET ?`).all(limit + 1, offset), limit);
}

export function listArtists(db, { limit = 48, offset = 0, sort = 'name' } = {}) {
  const order = sort === 'relevance' ? 'popularity DESC, id' : 'name COLLATE NOCASE, popularity DESC';
  return page(db.prepare(`SELECT id, name, country, artist_type, begin_year, ${ARTIST_PICTURE}, 'artist' AS type FROM artists ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit + 1, offset), limit);
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
  return db.prepare(`${ALBUM_LIST} WHERE albums.artist_id = ? ORDER BY release_date DESC LIMIT 60`).all(artistId);
}

export function genreAlbums(db, genreId, limit = 24) {
  return db.prepare(`${ALBUM_LIST} WHERE albums.id IN (SELECT album_id FROM album_genres WHERE genre_id = ? LIMIT 5000)
    ORDER BY popularity DESC LIMIT ?`).all(genreId, limit);
}

export function genreArtists(db, genreId, limit = 24) {
  return db.prepare(`SELECT artists.id, artists.name, ${ARTIST_PICTURE}, 'artist' AS type FROM artists
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
