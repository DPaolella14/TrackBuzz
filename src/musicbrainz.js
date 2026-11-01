const BASE_URL = 'https://musicbrainz.org/ws/2/';
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// MusicBrainz asks for at most one request per second and a descriptive User-Agent.
export class MusicBrainzClient {
  constructor({ contact, fetchImpl = fetch, sleep = defaultSleep, minIntervalMs = 1100, retries = 4 }) {
    this.userAgent = `TrackBuzz/0.1 ( ${contact} )`;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.minIntervalMs = minIntervalMs;
    this.retries = retries;
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  get(path, params = {}) {
    const run = this.queue.then(() => this.request(path, params));
    this.queue = run.catch(() => {});
    return run;
  }

  async request(path, params) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('fmt', 'json');
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        });
        if (response.ok) return await response.json();
        lastError = new Error(`MusicBrainz answered ${response.status} for ${url.pathname}`);
        if (response.status !== 429 && response.status < 500) throw Object.assign(lastError, { permanent: true });
      } catch (err) {
        if (err.permanent) throw err;
        lastError = err;
      }
      if (attempt < this.retries) await this.sleep(2000 * 2 ** attempt);
    }
    throw lastError;
  }

  searchArtists(query, limit = 5) {
    return this.get('artist', { query, limit });
  }

  searchReleaseGroups(query, { limit = 100, offset = 0 } = {}) {
    return this.get('release-group', { query, limit, offset });
  }

  searchRecordings(query, limit = 5) {
    return this.get('recording', { query, limit });
  }

  lookupArtist(id) {
    return this.get(`artist/${id}`, { inc: 'genres' });
  }

  lookupReleaseGroup(id) {
    return this.get(`release-group/${id}`, { inc: 'artist-credits+genres' });
  }

  browseArtistReleaseGroups(artistId, { limit = 100, offset = 0, type = 'album|ep' } = {}) {
    return this.get('release-group', { artist: artistId, type, limit, offset });
  }

  browseReleases(releaseGroupId) {
    return this.get('release', { 'release-group': releaseGroupId, status: 'official', inc: 'recordings+artist-credits', limit: 25 });
  }
}

// Lucene special characters must be escaped when a person's words go into a query.
export function escapeLucene(text) {
  return String(text).replace(/([+\-!(){}[\]^"~*?:\\/&|])/g, '\\$1');
}
