import { transaction } from './db.js';
import { isFullCatalog } from './catalog.js';
import { enqueueImport } from './importer.js';

const BASE_URL = 'https://api.listenbrainz.org/1/stats/sitewide/';
const RANGES = ['week', 'month', 'quarter'];
const CHART_SIZE = 50;
const URGENT_ARTISTS = 30;
const URGENT_ALBUMS = 30;
const REFRESH_HOURS = 24;

const KINDS = {
  artist: { path: 'artists', key: 'artists' },
  album: { path: 'release-groups', key: 'release_groups' },
  song: { path: 'recordings', key: 'recordings' },
};

function toEntry(kind, item) {
  if (kind === 'artist') {
    return item.artist_mbid ? { name: item.artist_name, artist: item.artist_name, mbid: item.artist_mbid, cover: null } : null;
  }
  if (kind === 'album') {
    if (!item.release_group_mbid) return null;
    return {
      name: item.release_group_name,
      artist: item.artist_name,
      mbid: item.release_group_mbid,
      cover: `https://coverartarchive.org/release-group/${item.release_group_mbid}/front-250`,
    };
  }
  if (!item.recording_mbid) return null;
  return {
    name: item.track_name,
    artist: item.artist_name,
    mbid: item.recording_mbid,
    cover: item.release_mbid ? `https://coverartarchive.org/release/${item.release_mbid}/front-250` : null,
  };
}

async function fetchChart(kind, fetchImpl, userAgent) {
  const { path, key } = KINDS[kind];
  // ListenBrainz may not have calculated the shortest period yet, so longer ones are the fallback.
  for (const range of RANGES) {
    const response = await fetchImpl(`${BASE_URL}${path}?range=${range}&count=${CHART_SIZE}`, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok && response.status !== 204) {
      const entries = ((await response.json()).payload?.[key] || []).map((item) => toEntry(kind, item)).filter(Boolean);
      if (entries.length) return entries;
    } else if (!response.ok && response.status !== 404) {
      throw new Error(`ListenBrainz answered ${response.status}`);
    }
  }
  return [];
}

export function chartsDue(db, now = Date.now()) {
  const { at } = db.prepare('SELECT max(updated_at) AS at FROM charts').get();
  return !at || now - Date.parse(`${at}Z`) >= REFRESH_HOURS * 3600000;
}

// Replaces each chart only when new data arrives, and moves popular music to the front of the import line.
export async function refreshCharts(db, { fetchImpl = fetch, userAgent = 'TrackBuzz' } = {}) {
  let refreshed = 0;
  for (const kind of Object.keys(KINDS)) {
    const entries = await fetchChart(kind, fetchImpl, userAgent);
    if (entries.length) {
      transaction(db, () => {
        db.prepare('DELETE FROM charts WHERE kind = ?').run(kind);
        const insert = db.prepare('INSERT INTO charts (kind, position, name, artist_name, mbid, cover_url) VALUES (?, ?, ?, ?, ?, ?)');
        entries.forEach((entry, index) => insert.run(kind, index + 1, entry.name, entry.artist, entry.mbid, entry.cover));
      });
      refreshed += 1;
      if (kind === 'artist' && !isFullCatalog(db)) {
        entries.slice(0, URGENT_ARTISTS).forEach((entry) => enqueueImport(db, 'artist_id', entry.mbid, { round: -1 }));
      }
      if (kind === 'album' && !isFullCatalog(db)) {
        entries.slice(0, URGENT_ALBUMS).forEach((entry) => enqueueImport(db, 'album', entry.mbid, { round: -1 }));
      }
    }
  }
  return refreshed;
}

export function homeCharts(db, { artists = 12, albums = 12, songs = 10 } = {}) {
  const artistRows = db.prepare(`
    SELECT charts.name, charts.mbid, local.id AS local_id,
      (SELECT cover_url FROM albums WHERE albums.artist_id = local.id AND cover_url IS NOT NULL
        ORDER BY (album_type = 'Album') DESC, release_date IS NULL, release_date LIMIT 1) AS local_cover,
      (SELECT cover_url FROM charts AS album_chart WHERE album_chart.kind = 'album' AND album_chart.artist_name = charts.name
        ORDER BY album_chart.position LIMIT 1) AS chart_cover
    FROM charts LEFT JOIN artists AS local ON local.mbid = charts.mbid
    WHERE charts.kind = 'artist' ORDER BY charts.position LIMIT ?`).all(artists);
  const albumRows = db.prepare(`
    SELECT charts.name, charts.artist_name, charts.mbid, charts.cover_url, local.id AS local_id
    FROM charts LEFT JOIN albums AS local ON local.mbid = charts.mbid
    WHERE charts.kind = 'album' ORDER BY charts.position LIMIT ?`).all(albums);
  const songRows = db.prepare(`
    SELECT charts.name, charts.artist_name, charts.mbid, charts.cover_url,
      (SELECT songs.id FROM songs WHERE songs.mbid = charts.mbid LIMIT 1) AS local_id
    FROM charts WHERE charts.kind = 'song' ORDER BY charts.position LIMIT ?`).all(songs);
  return {
    artists: artistRows.map((row) => ({
      type: 'artist', id: row.mbid, name: row.name, cover_url: row.local_cover || row.chart_cover,
      url: row.local_id ? `/artists/${row.local_id}` : `/open/artist/${row.mbid}`,
    })),
    albums: albumRows.map((row) => ({
      type: 'album', id: row.mbid, name: row.name, artist_credit: row.artist_name, cover_url: row.cover_url,
      url: row.local_id ? `/albums/${row.local_id}` : `/open/album/${row.mbid}`,
    })),
    songs: songRows.map((row) => ({
      type: 'song', id: row.mbid, name: row.name, artist_credit: row.artist_name, cover_url: row.cover_url,
      url: row.local_id ? `/songs/${row.local_id}` : `/open/recording/${row.mbid}`,
    })),
  };
}
