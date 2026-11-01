const BASE_URL = 'https://musicbrainz.org/ws/2/';
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const INTERACTIVE = { priority: 'interactive' };

// MusicBrainz asks for at most one request per second and a descriptive User-Agent.
// Someone waiting on a search goes ahead of background imports in the line for each slot.
export class MusicBrainzClient {
  constructor({ contact, fetchImpl = fetch, sleep = defaultSleep, minIntervalMs = 1100, retries = 4 }) {
    this.userAgent = `TrackBuzz/0.2 ( ${contact} )`;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.minIntervalMs = minIntervalMs;
    this.retries = retries;
    this.interactive = [];
    this.background = [];
    this.running = false;
    this.lastRequestAt = 0;
  }

  get interactiveWaiting() {
    return this.interactive.length;
  }

  get(path, params = {}, { priority = 'background', signal } = {}) {
    return new Promise((resolve, reject) => {
      const job = { path, params, signal, priority, resolve, reject };
      (priority === 'interactive' ? this.interactive : this.background).push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    for (;;) {
      const job = this.interactive.shift() || this.background.shift();
      if (!job) break;
      try {
        job.resolve(await this.request(job));
      } catch (err) {
        job.reject(err);
      }
    }
    this.running = false;
  }

  async request({ path, params, signal, priority }) {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('fmt', 'json');
    // A person is waiting on an interactive request, so it fails fast instead of backing off.
    const retries = priority === 'interactive' ? 0 : this.retries;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      signal?.throwIfAborted();
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      signal?.throwIfAborted();
      this.lastRequestAt = Date.now();
      try {
        const timeout = AbortSignal.timeout(priority === 'interactive' ? 10000 : 30000);
        const response = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.ok) return await response.json();
        lastError = new Error(`MusicBrainz answered ${response.status} for ${url.pathname}`);
        if (response.status !== 429 && response.status < 500) throw Object.assign(lastError, { permanent: true });
      } catch (err) {
        if (err.permanent || signal?.aborted) throw err;
        lastError = err;
      }
      if (attempt < retries) await this.sleep(2000 * 2 ** attempt);
    }
    throw lastError;
  }

  searchArtists(query, limit = 5, options) {
    return this.get('artist', { query, limit }, options);
  }

  searchReleaseGroups(query, { limit = 100, offset = 0, ...options } = {}) {
    return this.get('release-group', { query, limit, offset }, options);
  }

  searchRecordings(query, limit = 5, options) {
    return this.get('recording', { query, limit }, options);
  }

  lookupArtist(id, options) {
    return this.get(`artist/${id}`, { inc: 'genres' }, options);
  }

  lookupReleaseGroup(id, options) {
    return this.get(`release-group/${id}`, { inc: 'artist-credits+genres' }, options);
  }

  browseArtistReleaseGroups(artistId, { limit = 100, offset = 0, type = 'album|ep' } = {}) {
    return this.get('release-group', { artist: artistId, type, limit, offset, inc: 'artist-credits+genres' });
  }

  browseReleases(releaseGroupId, options) {
    return this.get('release', { 'release-group': releaseGroupId, status: 'official', inc: 'recordings+artist-credits', limit: 25 }, options);
  }
}

export { INTERACTIVE };

// Lucene special characters must be escaped when a person's words go into a query.
export function escapeLucene(text) {
  return String(text).replace(/([+\-!(){}[\]^"~*?:\\/&|])/g, '\\$1');
}
