import { randomBytes, timingSafeEqual } from 'node:crypto';
import { STATIC_FILES, assetCacheControl } from './assets.js';
import {
  RateLimiter, SESSION_MAX_AGE, createSession, destroySession, hashPassword, userFromSession, validateSignup, verifyPassword,
} from './auth.js';
import * as catalog from './catalog.js';
import { homeCharts } from './charts.js';
import { artistImportPending, enqueueImport, importStatus, isWantedGroup, libraryCounts, libraryLoading } from './importer.js';
import { LIVE_KINDS } from './live-search.js';
import { INTERACTIVE } from './musicbrainz.js';
import * as posts from './posts.js';
import * as views from './views.js';

const MAX_FORM_BYTES = 64 * 1024;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

class HttpError extends Error {
  constructor(status, heading, message) {
    super(message);
    this.status = status;
    this.heading = heading;
  }
}

const notFound = () => new HttpError(404, 'Page not found', 'That page doesn\'t exist or has been removed.');

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// Only same-site paths are valid redirect targets after logging in.
function safeNext(value) {
  const next = String(value || '');
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '';
}

function pageNumber(url) {
  const page = Number(url.searchParams.get('page'));
  return Number.isInteger(page) && page > 0 && page < 100000 ? page : 1;
}

const positiveId = (text) => {
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function readForm(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_FORM_BYTES) throw new HttpError(413, 'Post too long', 'That form is too large to send.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) throw new HttpError(413, 'Post too long', 'That form is too large to send.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const MBID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const OPEN_OPTIONS = { ...INTERACTIVE, force: true };

export function createApp({ db, config, importer = null, live = null }) {
  const limits = {
    loginAccount: new RateLimiter({ limit: 10, windowMs: 15 * 60000 }),
    // Many people can share one IP address, so these allow more than the per-account limit.
    loginIp: new RateLimiter({ limit: 50, windowMs: 15 * 60000 }),
    signup: new RateLimiter({ limit: config.signupLimitPerHour ?? 20, windowMs: 60 * 60000 }),
    post: new RateLimiter({ limit: 20, windowMs: 10 * 60000 }),
    request: new RateLimiter({ limit: 10, windowMs: 60 * 60000 }),
    suggest: new RateLimiter({ limit: 300, windowMs: 60000 }),
    live: new RateLimiter({ limit: 180, windowMs: 60000 }),
    open: new RateLimiter({ limit: 60, windowMs: 60000 }),
  };
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${config.secureCookies ? '; Secure' : ''}`;

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function send(ctx, { status, page }) {
    ctx.res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': ctx.cookies,
    });
    ctx.res.end(String(page));
  }

  function redirect(ctx, location) {
    ctx.res.writeHead(303, { ...SECURITY_HEADERS, Location: location, 'Set-Cookie': ctx.cookies, 'Cache-Control': 'no-store' });
    ctx.res.end();
  }

  function sendJson(ctx, data) {
    ctx.res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': ctx.cookies });
    ctx.res.end(JSON.stringify(data));
  }

  function requireUser(ctx) {
    if (!ctx.user) throw new HttpError(401, 'Log in to continue', 'You need an account to do that.');
  }

  function limit(limiter, key) {
    if (!limiter.allow(key)) throw new HttpError(429, 'Too many attempts', 'Wait a few minutes, then try again.');
  }

  function withTopics(rows) {
    return rows.map((post) => {
      const base = catalog.getTopic(db, post.topic_type, post.topic_id);
      return { post, topic: base };
    }).filter(({ topic }) => topic);
  }

  function renderTopic(ctx, topic, options = {}) {
    const requested = options.tab || ctx.url.searchParams.get('tab');
    const tab = posts.TABS[requested] ? requested : 'story';
    const page = options.page || pageNumber(ctx.url);
    const related = {};
    if (topic.type === 'album') related.songs = catalog.albumSongs(db, topic.id);
    if (topic.type === 'artist') {
      related.albums = catalog.artistAlbums(db, topic.id);
      related.importing = artistImportPending(db, topic.mbid);
    }
    if (topic.type === 'genre') {
      related.albums = catalog.genreAlbums(db, topic.id);
      related.artists = catalog.genreArtists(db, topic.id);
    }
    const form = { ...(options.form || {}) };
    if (ctx.user && tab === 'rating') form.existing = posts.userRating(db, ctx.user.id, topic.type, topic.id);
    send(ctx, views.topicPage(ctx, {
      topic,
      tab,
      page,
      form,
      related,
      status: options.status,
      stats: posts.topicStats(db, topic.type, topic.id),
      posts: posts.listTopicPosts(db, topic.type, topic.id, tab, { offset: (page - 1) * 20 }),
      genres: catalog.topicGenres(db, topic.type, topic.id),
    }));
  }

  function topicById(type, text) {
    const id = positiveId(text);
    const topic = id && catalog.getTopic(db, type, id);
    if (!topic) throw notFound();
    return topic;
  }

  function ownedPost(ctx, text) {
    requireUser(ctx);
    const id = positiveId(text);
    const post = id && posts.getPost(db, id);
    if (!post) throw notFound();
    if (post.user_id !== ctx.user.id) throw new HttpError(403, 'Not your post', 'You can only change your own posts.');
    return post;
  }

  const startSession = (ctx, userId) => {
    const token = createSession(db, userId);
    ctx.cookies.push(`tb_session=${token}; Max-Age=${SESSION_MAX_AGE}; ${cookieFlags}`);
  };

  async function importAlbum(mbid) {
    await importer.importReleaseGroup(mbid, OPEN_OPTIONS);
    const album = db.prepare('SELECT id FROM albums WHERE mbid = ?').get(mbid);
    if (!album) throw new HttpError(404, 'Couldn\'t open that', 'No track listing is available for this release yet.');
    return album;
  }

  async function openFromCatalog(ctx, action) {
    limit(limits.open, ctx.ip);
    if (!importer) throw notFound();
    try {
      return await action();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      console.error(`Opening from MusicBrainz failed: ${err.message}`);
      throw new HttpError(503, 'Couldn\'t open that', 'The music service isn\'t responding. Go back and try again in a moment.');
    }
  }

  const browse = (kind, lister, size) => (ctx) => {
    const page = pageNumber(ctx.url);
    send(ctx, views.browsePage(ctx, { kind, page, list: lister(db, { offset: (page - 1) * size }) }));
  };

  const routes = [
    ['GET', /^\/$/, (ctx) => {
      send(ctx, views.homePage(ctx, {
        albums: catalog.listAlbums(db, { limit: 12, releasedOnly: true }).items,
        charts: homeCharts(db),
        posts: withTopics(posts.recentPosts(db, 6)),
        genres: catalog.listGenres(db, { limit: 24 }).items,
        loading: libraryLoading(db),
        counts: libraryCounts(db),
      }));
    }],
    ['GET', /^\/healthz$/, (ctx) => {
      db.prepare('SELECT 1').get();
      sendJson(ctx, { ok: true });
    }],
    ['GET', /^\/search$/, (ctx) => {
      const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 120);
      const type = ctx.url.searchParams.get('type');
      const kind = catalog.TOPIC_TYPES.includes(type) ? type : null;
      const page = pageNumber(ctx.url);
      const results = catalog.search(db, q, { kind, offset: (page - 1) * 24 });
      send(ctx, views.searchPage(ctx, { q, kind, results, page, importState: q ? importStatus(db, q) : null }));
    }],
    ['GET', /^\/api\/suggest$/, (ctx) => {
      limit(limits.suggest, ctx.ip);
      const q = (ctx.url.searchParams.get('q') || '').trim().slice(0, 120);
      sendJson(ctx, { items: catalog.search(db, q, { limit: 8 }).items.map(views.suggestionItem) });
    }],
    ['GET', /^\/api\/live$/, async (ctx) => {
      limit(limits.live, ctx.ip);
      const kind = ctx.url.searchParams.get('kind');
      if (!live || !LIVE_KINDS.includes(kind)) return sendJson(ctx, { items: [] });
      const stop = new AbortController();
      ctx.res.on('close', () => stop.abort());
      try {
        return sendJson(ctx, { items: await live.search(kind, ctx.url.searchParams.get('q') || '', { signal: stop.signal }) });
      } catch (err) {
        if (stop.signal.aborted) return undefined;
        console.error(`Live search failed: ${err.message}`);
        return sendJson(ctx, { items: [], unavailable: true });
      }
    }],
    ['GET', new RegExp(`^/open/artist/(${MBID})$`), async (ctx, mbid) => {
      const id = await openFromCatalog(ctx, async () => {
        const artistId = await importer.ensureArtist({ id: mbid }, INTERACTIVE);
        enqueueImport(db, 'artist_id', mbid);
        return artistId;
      });
      redirect(ctx, `/artists/${id}`);
    }],
    ['GET', new RegExp(`^/open/album/(${MBID})$`), async (ctx, mbid) => {
      const album = await openFromCatalog(ctx, () => importAlbum(mbid));
      redirect(ctx, `/albums/${album.id}`);
    }],
    ['GET', new RegExp(`^/open/recording/(${MBID})$`), async (ctx, recordingId) => {
      const album = await openFromCatalog(ctx, async () => {
        const recording = await importer.mb.lookupRecording(recordingId, INTERACTIVE);
        const groups = (recording.releases || []).map((release) => release['release-group']).filter(Boolean);
        const group = groups.find(isWantedGroup) || groups[0];
        if (!group) throw new HttpError(404, 'Couldn\'t open that', 'No album is listed for this song yet.');
        return importAlbum(group.id);
      });
      const song = db.prepare('SELECT id FROM songs WHERE album_id = ? AND mbid = ? LIMIT 1').get(album.id, recordingId);
      redirect(ctx, song ? `/songs/${song.id}` : `/albums/${album.id}`);
    }],
    ['GET', new RegExp(`^/open/song/(${MBID})/(${MBID})$`), async (ctx, recordingId, groupId) => {
      const album = await openFromCatalog(ctx, () => importAlbum(groupId));
      const song = db.prepare('SELECT id FROM songs WHERE album_id = ? AND mbid = ? LIMIT 1').get(album.id, recordingId);
      redirect(ctx, song ? `/songs/${song.id}` : `/albums/${album.id}`);
    }],
    ['POST', /^\/catalog\/request$/, (ctx) => {
      requireUser(ctx);
      limit(limits.request, ctx.user.id);
      const q = (ctx.form.get('q') || '').trim().slice(0, 120);
      if (q) enqueueImport(db, 'search', q);
      redirect(ctx, `/search?q=${encodeURIComponent(q)}`);
    }],
    ['GET', /^\/albums$/, browse('album', catalog.listAlbums, 24)],
    ['GET', /^\/songs$/, browse('song', catalog.listSongs, 40)],
    ['GET', /^\/artists$/, browse('artist', catalog.listArtists, 48)],
    ['GET', /^\/genres$/, browse('genre', catalog.listGenres, 120)],
    ['GET', /^\/albums\/(\d+)$/, (ctx, id) => renderTopic(ctx, topicById('album', id))],
    ['GET', /^\/songs\/(\d+)$/, (ctx, id) => renderTopic(ctx, topicById('song', id))],
    ['GET', /^\/artists\/(\d+)$/, (ctx, id) => renderTopic(ctx, topicById('artist', id))],
    ['GET', /^\/genres\/([^/]+)$/, (ctx, slug) => {
      const topic = catalog.getGenreBySlug(db, decodeURIComponent(slug));
      if (!topic) throw notFound();
      renderTopic(ctx, topic);
    }],
    ['POST', /^\/posts$/, (ctx) => {
      requireUser(ctx);
      const type = ctx.form.get('topic_type');
      const tab = ctx.form.get('tab');
      if (!catalog.TOPIC_TYPES.includes(type) || !posts.TABS[tab]) throw new HttpError(400, 'Couldn\'t post that', 'Reload the page and try again.');
      const topic = topicById(type, ctx.form.get('topic_id'));
      limit(limits.post, ctx.user.id);
      const rawRating = ctx.form.get('rating');
      const result = posts.validatePost({ tab, body: ctx.form.get('body'), rating: rawRating });
      if (Object.keys(result.errors).length) {
        renderTopic(ctx, topic, { tab, page: 1, status: 422, form: { errors: result.errors, body: ctx.form.get('body'), rating: rawRating } });
        return;
      }
      if (tab === 'rating' && posts.userRating(db, ctx.user.id, topic.type, topic.id)) {
        redirect(ctx, catalog.topicUrl(topic, 'rating'));
        return;
      }
      const id = posts.createPost(db, { userId: ctx.user.id, type: topic.type, topicId: topic.id, tab, body: result.body, rating: result.rating });
      redirect(ctx, `${catalog.topicUrl(topic, tab)}#post-${id}`);
    }],
    ['GET', /^\/posts\/(\d+)\/edit$/, (ctx, id) => {
      const post = ownedPost(ctx, id);
      send(ctx, views.editPostPage(ctx, { post, topic: catalog.getTopic(db, post.topic_type, post.topic_id) }));
    }],
    ['POST', /^\/posts\/(\d+)\/edit$/, (ctx, id) => {
      const post = ownedPost(ctx, id);
      const topic = catalog.getTopic(db, post.topic_type, post.topic_id);
      const rawRating = ctx.form.get('rating');
      const result = posts.validatePost({ tab: post.tab, body: ctx.form.get('body'), rating: rawRating });
      if (Object.keys(result.errors).length) {
        send(ctx, views.editPostPage(ctx, { post, topic, status: 422, form: { errors: result.errors, body: ctx.form.get('body'), rating: rawRating } }));
        return;
      }
      posts.updatePost(db, post.id, result);
      redirect(ctx, `${catalog.topicUrl(topic, post.tab)}#post-${post.id}`);
    }],
    ['POST', /^\/posts\/(\d+)\/delete$/, (ctx, id) => {
      const post = ownedPost(ctx, id);
      const topic = catalog.getTopic(db, post.topic_type, post.topic_id);
      posts.deletePost(db, post.id);
      redirect(ctx, topic ? catalog.topicUrl(topic, post.tab) : '/');
    }],
    ['GET', /^\/signup$/, (ctx) => {
      if (ctx.user) return redirect(ctx, '/');
      return send(ctx, views.signupPage(ctx, { next: safeNext(ctx.url.searchParams.get('next')) }));
    }],
    ['POST', /^\/signup$/, async (ctx) => {
      limit(limits.signup, ctx.ip);
      const values = {
        username: (ctx.form.get('username') || '').trim(),
        email: (ctx.form.get('email') || '').trim().toLowerCase(),
      };
      const password = ctx.form.get('password') || '';
      const next = safeNext(ctx.form.get('next'));
      const errors = validateSignup({ ...values, password });
      if (!errors.username && db.prepare('SELECT 1 FROM users WHERE username_key = ?').get(values.username.toLowerCase())) {
        errors.username = 'That username is taken. Try another.';
      }
      if (!errors.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) {
        errors.email = 'An account with that email already exists. Log in instead.';
      }
      if (Object.keys(errors).length) {
        send(ctx, views.signupPage(ctx, { values, errors, next, status: 422 }));
        return;
      }
      const passwordHash = await hashPassword(password);
      let userId;
      try {
        userId = Number(db.prepare('INSERT INTO users (username, username_key, email, password_hash) VALUES (?, ?, ?, ?)')
          .run(values.username, values.username.toLowerCase(), values.email, passwordHash).lastInsertRowid);
      } catch (err) {
        // Two people can submit the same name at once; the database settles it.
        if (!String(err.message).includes('UNIQUE')) throw err;
        send(ctx, views.signupPage(ctx, { values, errors: { form: 'That username or email was just taken. Try another.' }, next, status: 422 }));
        return;
      }
      startSession(ctx, userId);
      redirect(ctx, next || '/');
    }],
    ['GET', /^\/login$/, (ctx) => {
      if (ctx.user) return redirect(ctx, '/');
      return send(ctx, views.loginPage(ctx, { next: safeNext(ctx.url.searchParams.get('next')) }));
    }],
    ['POST', /^\/login$/, async (ctx) => {
      const email = (ctx.form.get('email') || '').trim().toLowerCase();
      limit(limits.loginIp, ctx.ip);
      limit(limits.loginAccount, email);
      const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
      const next = safeNext(ctx.form.get('next'));
      const valid = await verifyPassword((ctx.form.get('password') || '').slice(0, 200), user?.password_hash);
      if (!valid) {
        send(ctx, views.loginPage(ctx, { values: { email }, error: 'That email and password don\'t match.', next, status: 422 }));
        return;
      }
      startSession(ctx, user.id);
      redirect(ctx, next || '/');
    }],
    ['POST', /^\/logout$/, (ctx) => {
      destroySession(db, ctx.sessionToken);
      ctx.cookies.push(`tb_session=; Max-Age=0; ${cookieFlags}`);
      redirect(ctx, '/');
    }],
    ['GET', /^\/u\/([A-Za-z0-9_]{3,24})$/, (ctx, username) => {
      const profile = db.prepare('SELECT id, username, created_at FROM users WHERE username_key = ?').get(username.toLowerCase());
      if (!profile) throw notFound();
      const page = pageNumber(ctx.url);
      const list = posts.userPosts(db, profile.id, { offset: (page - 1) * 20 });
      send(ctx, views.profilePage(ctx, { profile, page, posts: { items: withTopics(list.items), hasMore: list.hasMore } }));
    }],
  ];

  return async function handle(req, res) {
    const ctx = { req, res, cookies: [], user: null, form: null };
    try {
      ctx.url = new URL(req.url, 'http://localhost');
      ctx.ip = clientIp(req);
      const cookies = parseCookies(req.headers.cookie);
      ctx.sessionToken = cookies.tb_session;
      ctx.user = userFromSession(db, ctx.sessionToken);
      ctx.csrf = cookies.tb_csrf;
      if (!/^[A-Za-z0-9_-]{32,64}$/.test(ctx.csrf || '')) {
        ctx.csrf = randomBytes(24).toString('base64url');
        ctx.cookies.push(`tb_csrf=${ctx.csrf}; Max-Age=${SESSION_MAX_AGE}; ${cookieFlags}`);
      }

      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const asset = method === 'GET' && STATIC_FILES.get(ctx.url.pathname);
      if (asset) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type, 'Cache-Control': assetCacheControl(asset, ctx.url.searchParams.get('v')) });
        res.end(asset.body);
        return;
      }

      for (const [routeMethod, pattern, handler] of routes) {
        const match = routeMethod === method && pattern.exec(ctx.url.pathname);
        if (match) {
          if (method === 'POST') {
            ctx.form = await readForm(req);
            const origin = req.headers.origin;
            const expectedHost = config.trustProxy ? (req.headers['x-forwarded-host'] || req.headers.host) : req.headers.host;
            let crossSite = false;
            if (origin) {
              try { crossSite = new URL(origin).host !== expectedHost; } catch { crossSite = true; }
            }
            if (crossSite || !safeEqual(ctx.form.get('_csrf') || '', ctx.csrf)) {
              throw new HttpError(403, 'Form expired', 'Reload the page and try again.');
            }
          }
          await handler(ctx, ...match.slice(1));
          return;
        }
      }
      throw notFound();
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      ctx.csrf ||= '';
      if (err instanceof HttpError) {
        if (err.status === 401) {
          redirect(ctx, `/login?next=${encodeURIComponent(req.headers.referer ? safeRefererPath(req.headers.referer) : '/')}`);
          return;
        }
        send(ctx, views.errorPage(ctx, err.status, err.heading, err.message));
        return;
      }
      console.error(err);
      send(ctx, views.errorPage(ctx, 500, 'Something went wrong', 'The page couldn\'t load. Try again in a moment.'));
    }
  };
}

function safeRefererPath(referer) {
  try {
    const { pathname, search } = new URL(referer);
    return safeNext(`${pathname}${search}`) || '/';
  } catch {
    return '/';
  }
}
