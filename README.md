# TrackBuzz

Browse music and talk about it. Search for any album, song, artist, or genre, open it, and join one of four conversations:

- **Personal stories:** what the music means to you
- **Concerts:** what it was like live
- **Performance tips:** techniques for singing, playing, or producing
- **Ratings:** what you like or dislike, with a score from 0 to 10

Anyone can read. Posting requires a free account.

## Run it on your computer

You need [Node.js](https://nodejs.org) 22.13 or newer. There's nothing else to install.

To try the site with made-up bands and posts, and no imports:

```
npm run seed:demo
```

Then start it. In Windows PowerShell:

```
$env:CATALOG_SYNC="off"
npm start
```

In Windows Command Prompt:

```
set CATALOG_SYNC=off
npm start
```

On macOS, Linux, or Git Bash:

```
CATALOG_SYNC=off npm start
```

Open <http://localhost:3000> and log in with `demo_listener@example.com` and the password `demo-password-123`. The demo data lives in `data/trackbuzz.db`. Delete the `data` folder before you start importing real music.

Run the tests with `npm test`.

## Where the music comes from

The library comes from [MusicBrainz](https://musicbrainz.org), with cover art from the [Cover Art Archive](https://coverartarchive.org). TrackBuzz stores song and album information only. It doesn't play audio, which would need separate music licensing.

### Import the whole catalog

This loads every artist, album, and song from MusicBrainz's public data files. It keeps your existing posts and links, and your site isn't changed until the new library is finished.

Stop the site first, then check that your computer is ready:

```
npm run catalog:full-import -- --check
```

If it says you have enough space, run the import:

```
npm run catalog:full-import
```

Plan for several hours, mostly downloading and unpacking. Keep the computer awake. An interrupted download resumes, but an interruption after that means downloading again. When it finishes, run `npm start`. Your old library stays next to the new one as `trackbuzz.db.before-full-import`, and you can delete it once you're happy.

Options:

- `--work-dir=PATH` keeps temporary files on another drive. Set `DATABASE_PATH` too to keep the library there.
- `--no-genres` skips genres. MusicBrainz licenses them for non-commercial use only, while the rest of the catalog is public domain. Use this if the site makes money, unless you have an arrangement with MetaBrainz.

Search then runs on your own library and doesn't need MusicBrainz at all. MusicBrainz publishes new data files twice a week, and you can rerun the import any time.

### Staying up to date

With `CATALOG_SYNC` on, the running server adds new albums, EPs, and singles every 24 hours, up to 1,000 per run. Each run looks back 7 days to catch releases that were entered late.

The home page shows popular artists, albums, and songs from [ListenBrainz](https://listenbrainz.org), updated daily.

### Pictures

Albums and songs show their cover from the Cover Art Archive. Artists show the cover of their earliest studio album. MusicBrainz has no artist photos and not every album has a cover, so anything without a picture shows a generated pattern or its first letter.

### Before the full import

Without a full import, the site adds music gradually: it works through `catalog/starter-artists.txt` and popular ListenBrainz artists at about 3,000 albums an hour at most, and searches MusicBrainz as people type. To add something by hand, stop the server first:

```
npm run catalog:import -- "Radiohead"
npm run catalog:sync
```

**Before you make money from the site:** MusicBrainz's web service, used for daily updates, is free for non-commercial use. Commercial use, including ads or paid features, needs one of [MetaBrainz's plans](https://metabrainz.org/supporters) or an arrangement with them.

## Put it online

Use any host that runs Node.js or Docker and has a **persistent disk**, since all data is in one SQLite file. A `Dockerfile` is included. Set these on the host:

| Setting | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_PATH` | A path on the persistent disk, such as `/data/trackbuzz.db` |
| `TRUST_PROXY` | `1` if the host puts a load balancer in front of the app |
| `MUSICBRAINZ_CONTACT` | Your site or email address |

Serve the site over HTTPS, because login cookies are HTTPS-only in production. Run a single copy of the app, and back up the database file.

## How the code is organized

| Path | What it does |
| --- | --- |
| `src/app.js` | Pages, forms, and security checks |
| `src/views.js` | HTML for every page |
| `src/db.js` | Database tables and search index |
| `src/catalog.js` | Browsing and search |
| `src/posts.js` | Conversation tabs and posts |
| `src/auth.js` | Passwords, sessions, and rate limits |
| `src/musicbrainz.js` | MusicBrainz client |
| `src/live-search.js` | Search across all of MusicBrainz as people type |
| `src/importer.js` | Gradual imports and scheduled updates |
| `src/full-import.js` | Imports the whole catalog from MusicBrainz's data files |
| `src/charts.js` | Popular music for the home page |
| `public/` | Styles and browser script |

The app has no third-party packages. It uses Node's built-in web server and SQLite.

## Not built yet

- Password reset, which needs an email service
- Moderation tools for reporting and removing other people's posts
- Deleting an account from the site
