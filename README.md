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

With `CATALOG_SYNC` on, the running server keeps the library current by itself:

1. **Bulk import:** it works through the artists in `catalog/starter-artists.txt`, plus popular artists from [ListenBrainz](https://listenbrainz.org). Every artist's first album is added before anyone's second, up to 40 per artist. Add names to the file at any time, then restart.
2. **Every 24 hours:** it adds new albums, EPs, and singles, up to 200 per run, even while a bulk import is running. Each run looks back 7 days to catch releases that were entered late.
3. **On demand:** search looks through all of MusicBrainz as people type. Opening a result adds it to the site right away, and opening an artist also queues their albums.

The home page shows popular artists, albums, and songs from ListenBrainz, updated daily, and that music is imported first. Artist pictures use the cover of the artist's earliest studio album.

MusicBrainz allows one request per second, so a full starter import takes a while. An album takes about one second and an artist about three, so roughly 3,000 albums an hour at most. Searches go ahead of background imports, and MusicBrainz results arrive one type at a time over a few seconds. Library results appear instantly. If the site gets busy, this limit is the first thing you'll hit, and MetaBrainz's commercial plans or hosting your own MusicBrainz mirror are the ways past it. Change the limits in `.env` (see `.env.example`).

To import by hand, stop the server first so the rate limit is respected:

```
npm run catalog:import -- "Radiohead"
npm run catalog:sync
```

**Before you make money from the site:** MusicBrainz's web service is free for non-commercial use. Commercial use, including ads or paid features, needs one of [MetaBrainz's plans](https://metabrainz.org/supporters) or an arrangement with them.

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
| `src/importer.js` | Imports and scheduled updates |
| `public/` | Styles and browser script |

The app has no third-party packages. It uses Node's built-in web server and SQLite.

## Not built yet

- Password reset, which needs an email service
- Moderation tools for reporting and removing other people's posts
- Deleting an account from the site
