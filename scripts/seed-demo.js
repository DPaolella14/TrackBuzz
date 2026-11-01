// Fills a local database with made-up bands and posts, so the site can be tried without importing anything.
import { hashPassword } from '../src/auth.js';
import { ensureGenre } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { openDb, transaction } from '../src/db.js';
import { createPost } from '../src/posts.js';

const config = loadConfig();
if (config.production) {
  console.error('Demo data is for local development only.');
  process.exit(1);
}
const db = openDb(config.databasePath);
if (db.prepare('SELECT 1 FROM users WHERE username_key = ?').get('demo_listener')) {
  console.log('Demo data is already loaded.');
  process.exit(0);
}

const CATALOG = [
  { name: 'The Paper Lanterns', country: 'US', type: 'Group', begin: 2009, genres: ['indie rock', 'dream pop'], albums: [
    { title: 'Porchlight Static', date: '2026-10-24', type: 'Album', songs: ['Porchlight Static', 'Slow Exit', 'Grandmother\'s Radio', 'Northbound', 'Ash and Honey'] },
    { title: 'Small Town Satellites', date: '2019-05-17', type: 'Album', songs: ['Satellite Hymn', 'County Line', 'Paper Moon Motel', 'Static Prayer'] },
  ] },
  { name: 'Marisol Vega', country: 'MX', type: 'Person', begin: 2014, genres: ['neo soul', 'jazz'], albums: [
    { title: 'Blue Hour Letters', date: '2026-09-12', type: 'Album', songs: ['Dear Tuesday', 'Blue Hour', 'Slow Burn Waltz', 'Letters Home'] },
    { title: 'Corner Booth', date: '2021-02-05', type: 'EP', songs: ['Corner Booth', 'Last Call Lullaby', 'Mercury'] },
  ] },
  { name: 'Iron Tidepool', country: 'NO', type: 'Group', begin: 1998, genres: ['progressive metal'], albums: [
    { title: 'Abyssal Choir', date: '2024-11-29', type: 'Album', songs: ['Pressure Line', 'Abyssal Choir', 'Salt in the Machine', 'Undertow Canon'] },
  ] },
  { name: 'Kofi Ansah Quartet', country: 'GH', type: 'Group', begin: 2011, genres: ['jazz', 'afrobeat'], albums: [
    { title: 'Harmattan Sessions', date: '2025-03-21', type: 'Album', songs: ['Harmattan', 'Night Market', 'Kumasi Blue', 'Second Line to Accra'] },
  ] },
  { name: 'Neon Orchard', country: 'GB', type: 'Group', begin: 2017, genres: ['synthpop', 'electronic'], albums: [
    { title: 'Glasshouse', date: '2026-08-01', type: 'Album', songs: ['Glasshouse', 'Afterimage', 'Pollen Count', 'Soft Reset', 'Fruit Machine'] },
  ] },
];
const seconds = (index) => (172 + (index * 47) % 140) * 1000;

const USERS = ['demo_listener', 'nightbus_nora', 'fretboard_finn', 'mixdown_maya'];
const passwordHash = await hashPassword('demo-password-123');

transaction(db, () => {
  const ids = {};
  for (const username of USERS) {
    ids[username] = Number(db.prepare('INSERT INTO users (username, username_key, email, password_hash) VALUES (?, ?, ?, ?)')
      .run(username, username, `${username}@example.com`, passwordHash).lastInsertRowid);
  }
  const insertAlbum = db.prepare('INSERT INTO albums (title, artist_id, artist_credit, release_date, album_type) VALUES (?, ?, ?, ?, ?)');
  const insertSong = db.prepare('INSERT INTO songs (title, album_id, artist_id, artist_credit, position, duration_ms) VALUES (?, ?, ?, ?, ?, ?)');
  const found = {};
  for (const artist of CATALOG) {
    const artistId = Number(db.prepare('INSERT INTO artists (name, country, artist_type, begin_year) VALUES (?, ?, ?, ?)')
      .run(artist.name, artist.country, artist.type, artist.begin).lastInsertRowid);
    found[artist.name] = artistId;
    const genreIds = artist.genres.map((genre) => ensureGenre(db, genre));
    genreIds.forEach((genreId) => db.prepare('INSERT INTO artist_genres VALUES (?, ?)').run(artistId, genreId));
    for (const album of artist.albums) {
      const albumId = Number(insertAlbum.run(album.title, artistId, artist.name, album.date, album.type).lastInsertRowid);
      found[album.title] = albumId;
      genreIds.forEach((genreId) => db.prepare('INSERT INTO album_genres VALUES (?, ?)').run(albumId, genreId));
      album.songs.forEach((title, index) => {
        const songId = Number(insertSong.run(title, albumId, artistId, artist.name, index + 1, seconds(albumId * 3 + index)).lastInsertRowid);
        found[`song:${title}`] = songId;
      });
    }
  }
  const post = (user, type, key, tab, body, rating = null) => createPost(db, { userId: ids[user], type, topicId: found[key], tab, body, rating });
  post('nightbus_nora', 'album', 'Porchlight Static', 'story', 'I drove my sister to college with this album on repeat. We didn\'t talk much, but by the third listen we were both singing the harmony on Northbound. Now it\'s the sound of that whole September.');
  post('fretboard_finn', 'album', 'Porchlight Static', 'tips', 'The guitar on Slow Exit is simpler than it sounds. Capo on 2, let the open strings ring, and use a slapback delay around 120 ms. Pick near the neck to keep it soft.');
  post('mixdown_maya', 'album', 'Porchlight Static', 'rating', 'Love the tape hiss and how close the vocals sit. The last two tracks lose some momentum, but the opening run is close to perfect.', 8);
  post('nightbus_nora', 'album', 'Porchlight Static', 'rating', 'Warm, patient, and made for long drives. I only wish it were longer.', 9);
  post('demo_listener', 'artist', 'The Paper Lanterns', 'concert', 'Saw them in a 300-cap room last spring. The power went out during Satellite Hymn, and they finished it acoustic in the dark with the whole crowd singing.');
  post('fretboard_finn', 'artist', 'Iron Tidepool', 'tips', 'Practice the riffs at half speed with a metronome, and accent only the first note of each group. Clean alternate picking matters more than speed here.');
  post('mixdown_maya', 'song', 'song:Blue Hour', 'tips', 'To get that close vocal sound, sing a few inches off a ribbon mic and compress gently, with a slow attack. Let the breaths stay in the take.');
  post('nightbus_nora', 'song', 'song:Harmattan', 'story', 'This song was playing the first time I cooked for my in-laws. Everything burned, but we all still laugh about it whenever it comes on.');
  post('demo_listener', 'album', 'Glasshouse', 'rating', 'Great hooks and textures, though it runs together a bit in the middle.', 7);
});
console.log('Demo data loaded. Log in with demo_listener@example.com and the password demo-password-123.');
db.close();
