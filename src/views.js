import { createHash } from 'node:crypto';
import { assetUrl } from './assets.js';
import { html } from './html.js';
import { TABS, MAX_BODY } from './posts.js';
import { topicUrl } from './catalog.js';

const KIND_LABEL = { album: 'Album', song: 'Song', artist: 'Artist', genre: 'Genre' };
const KIND_PLURAL = { album: 'Albums', song: 'Songs', artist: 'Artists', genre: 'Genres' };

const csrfField = (ctx) => html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`;

export function formatDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10).split('-').map(Number);
  if (parts.length === 1 || !parts[1]) return String(parts[0]);
  if (parts.length === 2 || !parts[2]) {
    return new Date(Date.UTC(parts[0], parts[1] - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function formatDuration(ms) {
  if (!ms) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const yearOf = (date) => String(date || '').slice(0, 4);

// A printed-looking placeholder that is unique to each title, shown until (or instead of) cover art.
const logoMark = html`<svg class="logo-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
  <path fill="#f6f4ff" d="M11 3h18a9 9 0 0 1 9 9v10a9 9 0 0 1-9 9H17l-8 7v-7.2A9 9 0 0 1 2 22V12a9 9 0 0 1 9-9z"></path>
  <rect x="9.5" y="13" width="4" height="8" rx="2" fill="#ff5c8a"></rect>
  <rect x="15.5" y="8" width="4" height="18" rx="2" fill="#f59f00"></rect>
  <rect x="21.5" y="11" width="4" height="12" rx="2" fill="#12b89a"></rect>
  <rect x="27.5" y="14" width="4" height="6" rx="2" fill="#7a63ff"></rect>
</svg>`;

function placeholderArt(seed) {
  const bytes = createHash('sha1').update(String(seed)).digest();
  const inks = ['var(--pink)', 'var(--amber)', 'var(--teal)', 'var(--violet)'];
  const first = inks[bytes[0] % 4];
  const second = inks[(bytes[0] % 4 + 1 + (bytes[1] % 3)) % 4];
  const cx = 20 + (bytes[2] % 60);
  const cy = 20 + (bytes[3] % 60);
  const radius = 20 + (bytes[4] % 26);
  const bars = Array.from({ length: 8 }, (_, i) => {
    const height = 8 + (bytes[5 + i] % 42);
    return html`<rect x="${6 + i * 11.5}" y="${94 - height}" width="7" height="${height}" fill="${second}"></rect>`;
  });
  return html`<svg class="art-placeholder" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <rect width="100" height="100" fill="var(--surface-2)"></rect>
    <circle class="overprint" cx="${cx}" cy="${cy}" r="${radius}" fill="${first}"></circle>
    <g class="overprint">${bars}</g>
  </svg>`;
}

function cover(item, size = 'medium') {
  return html`<span class="cover cover-${size}">
    ${placeholderArt(`${item.type}:${item.id}:${item.name}`)}
    ${item.cover_url ? html`<img src="${item.cover_url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
  </span>`;
}

function meter(value, { label } = {}) {
  const filled = Math.round(value);
  const shown = Number.isInteger(value) ? value : value.toFixed(1);
  const cells = Array.from({ length: 10 }, (_, i) => {
    const level = i < 6 ? 'low' : i < 8 ? 'mid' : 'high';
    return html`<span class="meter-cell ${i < filled ? `on-${level}` : ''}"></span>`;
  });
  return html`<span class="meter" role="img" aria-label="${label || 'Rated'} ${shown} out of 10">
    <span class="meter-cells" aria-hidden="true">${cells}</span>
    <strong class="meter-value" aria-hidden="true">${shown}</strong>
  </span>`;
}

function searchForm(id, q = '', extraClass = '') {
  return html`<form class="search ${extraClass}" action="/search" method="get" role="search" data-suggest>
    <label class="visually-hidden" for="${id}">Search for an album, song, artist, or genre</label>
    <input id="${id}" name="q" type="search" value="${q}" maxlength="120" autocomplete="off"
      placeholder="Album, song, artist, or genre" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list">
    <button type="submit">Search</button>
    <ul class="suggestions" id="${id}-list" role="listbox" hidden></ul>
  </form>`;
}

export function layout(ctx, { title, body, q = '', hero = false, status = 200 }) {
  const fullTitle = title ? `${title} | TrackBuzz` : 'TrackBuzz: talk about the music you love';
  const page = html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${fullTitle}</title>
  <meta name="description" content="Share personal stories, concert memories, performance tips, and ratings for any album, song, artist, or genre.">
  <link rel="icon" href="${assetUrl('/favicon.svg')}" type="image/svg+xml">
  <link rel="stylesheet" href="${assetUrl('/styles.css')}">
  <script src="${assetUrl('/app.js')}" defer></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <a class="logo" href="/" aria-label="TrackBuzz home">${logoMark}<span class="logo-word">Track<span>Buzz</span></span></a>
    <nav class="site-nav" aria-label="Browse">
      <a href="/albums">Albums</a>
      <a href="/songs">Songs</a>
      <a href="/artists">Artists</a>
      <a href="/genres">Genres</a>
    </nav>
    ${hero ? '' : searchForm('site-search', q, 'search-compact')}
    <div class="account">
      ${ctx.user
    ? html`<a href="/u/${ctx.user.username}">${ctx.user.username}</a>
        <form action="/logout" method="post">${csrfField(ctx)}<button class="link-button" type="submit">Log out</button></form>`
    : html`<a href="/login">Log in</a><a class="button button-small" href="/signup">Sign up</a>`}
    </div>
  </header>
  <main id="main">${body}</main>
  <footer class="site-footer">
    <p>Music information from <a href="https://musicbrainz.org" rel="noopener">MusicBrainz</a>, used under its data licenses. Cover art from the <a href="https://coverartarchive.org" rel="noopener">Cover Art Archive</a>.</p>
  </footer>
</body>
</html>`;
  return { status, page };
}

function albumGrid(albums) {
  return html`<ul class="album-grid">${albums.map((album) => html`<li>
    <a class="album-tile" href="${topicUrl(album)}">
      ${cover(album)}
      <span class="tile-title">${album.name}</span>
      <span class="tile-meta">${album.artist_credit}${album.release_date ? `, ${yearOf(album.release_date)}` : ''}</span>
    </a>
  </li>`)}</ul>`;
}

function songRows(songs, { showAlbum = true, numbered = false } = {}) {
  return html`<ol class="song-list ${numbered ? 'numbered' : ''}">${songs.map((song) => html`<li>
    <a href="${topicUrl(song)}">
      ${numbered ? html`<span class="song-number">${song.position}</span>` : cover(song, 'small')}
      <span class="song-main">
        <span class="song-title">${song.name}</span>
        <span class="tile-meta">${song.artist_credit}${showAlbum ? `, ${song.album_title}` : ''}</span>
      </span>
      <span class="song-duration">${formatDuration(song.duration_ms)}</span>
    </a>
  </li>`)}</ol>`;
}

function genreChips(genres) {
  return html`<ul class="chips">${genres.map((genre) => html`<li><a class="chip" href="${topicUrl(genre)}">${genre.name}</a></li>`)}</ul>`;
}

function postTopicLink(post, topic) {
  return topic ? html`<a href="${topicUrl(topic, post.tab)}">${topic.name}</a>` : '';
}

function postCard(ctx, post, { topic = null } = {}) {
  const own = ctx.user && ctx.user.id === post.user_id;
  return html`<article class="post tab-${post.tab}" id="post-${post.id}">
    <header class="post-head">
      <a class="post-author" href="/u/${post.username}">${post.username}</a>
      ${topic ? html`<span class="post-context">${TABS[post.tab].label} on ${postTopicLink(post, topic)}</span>` : ''}
      <time class="post-date" datetime="${post.created_at.replace(' ', 'T')}Z">${formatDate(post.created_at)}${post.edited_at ? ', edited' : ''}</time>
    </header>
    ${post.tab === 'rating' ? meter(post.rating) : ''}
    <p class="post-body">${post.body}</p>
    ${own ? html`<div class="post-actions">
      <a href="/posts/${post.id}/edit">Edit</a>
      <form action="/posts/${post.id}/delete" method="post" data-confirm="Delete this post? This can't be undone.">
        ${csrfField(ctx)}<button class="link-button" type="submit">Delete</button>
      </form>
    </div>` : ''}
  </article>`;
}

function ratingPicker(selected, error) {
  const values = Array.from({ length: 11 }, (_, i) => i);
  return html`<fieldset class="rating-picker ${error ? 'has-error' : ''}">
    <legend>Your rating, from 0 to 10</legend>
    <div class="rating-options">
      ${values.map((value) => html`<label class="rating-option level-${value < 7 ? 'low' : value < 9 ? 'mid' : 'high'}">
        <input type="radio" name="rating" value="${value}" required ${String(selected) === String(value) ? html`checked` : ''}>
        <span>${value}</span>
      </label>`)}
    </div>
    ${error ? html`<p class="field-error">${error}</p>` : ''}
  </fieldset>`;
}

function postForm(ctx, topic, tab, form = {}) {
  const config = TABS[tab];
  if (!ctx.user) {
    const next = encodeURIComponent(topicUrl(topic, tab));
    return html`<div class="prompt-signin">
      <p>${config.prompt(topic.name)}</p>
      <a class="button" href="/login?next=${next}">Log in to post</a>
      <a href="/signup?next=${next}">Create an account</a>
    </div>`;
  }
  if (tab === 'rating' && form.existing) {
    return html`<div class="prompt-signin">
      <p>You rated ${topic.name} ${form.existing.rating} out of 10.</p>
      <a class="button" href="/posts/${form.existing.id}/edit">Edit your rating</a>
    </div>`;
  }
  const errors = form.errors || {};
  return html`<form class="post-form" action="/posts" method="post">
    ${csrfField(ctx)}
    <input type="hidden" name="topic_type" value="${topic.type}">
    <input type="hidden" name="topic_id" value="${topic.id}">
    <input type="hidden" name="tab" value="${tab}">
    ${tab === 'rating' ? ratingPicker(form.rating, errors.rating) : ''}
    <label for="post-body">${config.prompt(topic.name)}</label>
    <textarea id="post-body" name="body" rows="5" maxlength="${MAX_BODY}" required>${form.body || ''}</textarea>
    ${errors.body ? html`<p class="field-error">${errors.body}</p>` : ''}
    ${errors.form ? html`<p class="field-error">${errors.form}</p>` : ''}
    <button class="button" type="submit">${config.action}</button>
  </form>`;
}

function pager(basePath, params, page, hasMore) {
  if (page <= 1 && !hasMore) return '';
  const link = (target) => {
    const search = new URLSearchParams({ ...params, page: String(target) });
    return `${basePath}?${search}`;
  };
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1 ? html`<a href="${link(page - 1)}" rel="prev">Previous page</a>` : ''}
    ${hasMore ? html`<a href="${link(page + 1)}" rel="next">Next page</a>` : ''}
  </nav>`;
}

export function homePage(ctx, { albums, posts, genres, loading }) {
  return layout(ctx, {
    hero: true,
    body: html`
    <section class="hero">
      <h1>What's the song behind your story?</h1>
      <p>Find any album, song, artist, or genre. Then share a personal story, a concert memory, a performance tip, or a rating.</p>
      ${searchForm('home-search')}
      <div class="hero-wave" aria-hidden="true">${Array.from({ length: 48 }, () => html`<span></span>`)}</div>
    </section>
    ${albums.length ? html`<section class="section">
      <div class="section-head"><h2>New releases</h2><a href="/albums">All albums</a></div>
      ${albumGrid(albums)}
    </section>` : html`<section class="section empty" ${loading ? html`data-auto-refresh` : ''}>
      <h2>${loading ? 'The first albums are on their way' : 'Search to get started'}</h2>
      <p>${loading ? 'This page updates when they arrive. You can already search for any artist, album, or song above.' : 'Search for any artist, album, or song above.'}</p>
    </section>`}
    <div class="home-columns">
      <section class="section">
        <h2>Latest from listeners</h2>
        ${posts.length ? posts.map(({ post, topic }) => postCard(ctx, post, { topic }))
    : html`<p class="empty-text">No posts yet. Search for something you love and start the conversation.</p>`}
      </section>
      ${genres.length ? html`<section class="section">
        <div class="section-head"><h2>Genres</h2><a href="/genres">All genres</a></div>
        ${genreChips(genres)}
      </section>` : ''}
    </div>`,
  });
}

function resultRow(item) {
  const detail = {
    album: () => `Album by ${item.artist_credit}${item.release_date ? `, ${yearOf(item.release_date)}` : ''}`,
    song: () => `Song by ${item.artist_credit}, on ${item.album_title}`,
    artist: () => ['Artist', item.country, item.begin_year ? `since ${item.begin_year}` : ''].filter(Boolean).join(', '),
    genre: () => 'Genre',
  }[item.type]();
  return html`<li><a class="result" href="${topicUrl(item)}">
    ${cover(item, 'small')}
    <span class="song-main"><span class="song-title">${item.name}</span><span class="tile-meta">${detail}</span></span>
  </a></li>`;
}

export function suggestionItem(item) {
  const context = { album: `Album by ${item.artist_credit}`, song: `Song by ${item.artist_credit}`, artist: 'Artist', genre: 'Genre' }[item.type];
  return { kind: item.type, name: item.name, context, cover: item.cover_url || null, url: topicUrl(item) };
}

export function searchPage(ctx, { q, kind, results, page, importState }) {
  const filters = [['', 'All'], ...Object.keys(KIND_PLURAL).map((key) => [key, KIND_PLURAL[key]])];
  const total = Object.values(results.counts).reduce((sum, count) => sum + count, 0);
  const searchMore = !q ? '' : importState === 'pending'
    ? html`<p class="import-note" role="status">Looking for "${q}" on MusicBrainz. Anything found will appear here in a few minutes.</p>`
    : ctx.user ? html`<noscript><form class="import-note" action="/catalog/request" method="post">
        ${csrfField(ctx)}<input type="hidden" name="q" value="${q}">
        <span>Can't find what you're looking for?</span>
        <button class="button button-small" type="submit">Add "${q}" to the library</button>
      </form></noscript>` : '';
  const showLive = q && !kind && page === 1;
  return layout(ctx, {
    title: q ? `Search: ${q}` : 'Search',
    q,
    body: html`<section class="section">
      <h1 class="page-title">${q ? `Results for "${q}"` : 'Search'}</h1>
      ${q ? html`<ul class="filters">${filters.map(([key, label]) => {
    const count = key ? (results.counts[key] || 0) : total;
    const params = new URLSearchParams({ q, ...(key ? { type: key } : {}) });
    return html`<li><a href="/search?${params}" ${kind === (key || null) ? html`aria-current="page"` : ''}>${label} (${count})</a></li>`;
  })}</ul>` : html`<p>Enter an album, song, artist, or genre in the search bar.</p>`}
      ${results.items.length ? html`<ul class="result-list">${results.items.map(resultRow)}</ul>`
    : q ? html`<p class="empty-text">Nothing in the library matches "${q}"${kind ? ` in ${KIND_PLURAL[kind].toLowerCase()}` : ''}.</p>` : ''}
      ${pager('/search', { q, ...(kind ? { type: kind } : {}) }, page, results.hasMore)}
      ${showLive ? html`<section class="live-section" data-live-results="${q}">
        <h2>More from MusicBrainz</h2>
        <ul class="result-list"></ul>
        <p class="live-status" role="status">Searching all music</p>
      </section>` : ''}
      ${searchMore}
    </section>`,
  });
}

export function browsePage(ctx, { kind, list, page }) {
  const content = {
    album: () => albumGrid(list.items),
    song: () => songRows(list.items),
    artist: () => html`<ul class="result-list two-column">${list.items.map(resultRow)}</ul>`,
    genre: () => genreChips(list.items),
  }[kind]();
  return layout(ctx, {
    title: KIND_PLURAL[kind],
    body: html`<section class="section">
      <h1 class="page-title">${KIND_PLURAL[kind]}</h1>
      ${list.items.length ? content : html`<p class="empty-text">Nothing here yet. The library updates automatically, so check back soon.</p>`}
      ${pager(`/${kind}s`, {}, page, list.hasMore)}
    </section>`,
  });
}

function topicFacts(topic) {
  switch (topic.type) {
    case 'album':
      return html`<p class="topic-byline">${topic.album_type || 'Album'} by <a href="/artists/${topic.artist_id}">${topic.artist_credit}</a></p>
        ${topic.release_date ? html`<p class="topic-fact">Released ${formatDate(topic.release_date)}</p>` : ''}`;
    case 'song':
      return html`<p class="topic-byline">Song by <a href="/artists/${topic.artist_id}">${topic.artist_credit}</a></p>
        <p class="topic-fact">On <a href="/albums/${topic.album_id}">${topic.album_title}</a>${topic.duration_ms ? `, ${formatDuration(topic.duration_ms)}` : ''}</p>`;
    case 'artist': {
      const facts = [topic.artist_type, topic.country, topic.begin_year ? `since ${topic.begin_year}` : ''].filter(Boolean).join(', ');
      return html`<p class="topic-byline">Artist</p>${facts ? html`<p class="topic-fact">${facts}</p>` : ''}`;
    }
    default:
      return html`<p class="topic-byline">Genre</p>`;
  }
}

function topicRelated({ topic, related }) {
  switch (topic.type) {
    case 'album':
      return related.songs.length ? html`<section class="section"><h2>Songs on this album</h2>${songRows(related.songs, { showAlbum: false, numbered: true })}</section>` : '';
    case 'artist':
      return html`${related.albums.length ? html`<section class="section"><h2>Albums and EPs</h2>${albumGrid(related.albums)}</section>` : ''}
        ${related.importing ? html`<p class="section live-status" data-auto-refresh role="status">Adding this artist's albums. This page updates as they arrive.</p>` : ''}`;
    case 'genre':
      return html`${related.albums.length ? html`<section class="section"><h2>Albums</h2>${albumGrid(related.albums)}</section>` : ''}
        ${related.artists.length ? html`<section class="section"><h2>Artists</h2><ul class="chips">${related.artists.map((artist) => html`<li><a class="chip" href="${topicUrl(artist)}">${artist.name}</a></li>`)}</ul></section>` : ''}`;
    default:
      return '';
  }
}

export function topicPage(ctx, { topic, tab, stats, posts, page, genres, related, form, status = 200 }) {
  return layout(ctx, {
    title: topic.name,
    status,
    body: html`<article class="topic">
      <header class="topic-head">
        ${cover(topic, 'large')}
        <div class="topic-info">
          <h1>${topic.name}</h1>
          ${topicFacts(topic)}
          ${genres.length ? genreChips(genres) : ''}
          ${stats.counts.rating ? html`<div class="topic-rating">
            ${meter(stats.average, { label: 'Average rating' })}
            <span>average of ${stats.counts.rating} ${stats.counts.rating === 1 ? 'rating' : 'ratings'}</span>
          </div>` : ''}
        </div>
      </header>
      <nav class="tabs" aria-label="Conversations about ${topic.name}">
        ${Object.entries(TABS).map(([key, config]) => html`<a class="tab tab-${key}" href="${topicUrl(topic, key)}#conversation" ${key === tab ? html`aria-current="page"` : ''}>
          <span class="tab-label">${config.label}</span><span class="tab-count">${stats.counts[key]}</span>
        </a>`)}
      </nav>
      <section class="conversation tab-${tab}" id="conversation">
        <h2 class="visually-hidden">${TABS[tab].label}</h2>
        ${postForm(ctx, topic, tab, form)}
        ${posts.items.length ? posts.items.map((post) => postCard(ctx, post)) : html`<p class="empty-text">${TABS[tab].empty}</p>`}
        ${pager(topicUrl(topic), { tab }, page, posts.hasMore)}
      </section>
    </article>
    ${topicRelated({ topic, related })}`,
  });
}

export function editPostPage(ctx, { post, topic, form = {}, status = 200 }) {
  const errors = form.errors || {};
  return layout(ctx, {
    title: 'Edit post',
    status,
    body: html`<section class="section narrow">
      <h1 class="page-title">Edit your post</h1>
      <p>${TABS[post.tab].label} on <a href="${topicUrl(topic, post.tab)}">${topic.name}</a></p>
      <form class="post-form tab-${post.tab}" action="/posts/${post.id}/edit" method="post">
        ${csrfField(ctx)}
        ${post.tab === 'rating' ? ratingPicker(form.rating ?? post.rating, errors.rating) : ''}
        <label for="post-body">Your post</label>
        <textarea id="post-body" name="body" rows="7" maxlength="${MAX_BODY}" required>${form.body ?? post.body}</textarea>
        ${errors.body ? html`<p class="field-error">${errors.body}</p>` : ''}
        <button class="button" type="submit">Save changes</button>
      </form>
    </section>`,
  });
}

function field({ name, label, type = 'text', value = '', error, autocomplete, hint }) {
  return html`<div class="field">
    <label for="${name}">${label}</label>
    <input id="${name}" name="${name}" type="${type}" value="${value}" autocomplete="${autocomplete}" required
      ${error ? html`aria-invalid="true"` : ''}>
    ${hint && !error ? html`<p class="field-hint">${hint}</p>` : ''}
    ${error ? html`<p class="field-error">${error}</p>` : ''}
  </div>`;
}

export function signupPage(ctx, { values = {}, errors = {}, next = '', status = 200 }) {
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : '';
  return layout(ctx, {
    title: 'Sign up',
    status,
    body: html`<section class="section narrow">
      <h1 class="page-title">Create your account</h1>
      <form class="auth-form" action="/signup" method="post">
        ${csrfField(ctx)}<input type="hidden" name="next" value="${next}">
        ${field({ name: 'username', label: 'Username', value: values.username, error: errors.username, autocomplete: 'username', hint: 'Shown on your posts.' })}
        ${field({ name: 'email', label: 'Email', type: 'email', value: values.email, error: errors.email, autocomplete: 'email', hint: 'Never shown publicly.' })}
        ${field({ name: 'password', label: 'Password', type: 'password', error: errors.password, autocomplete: 'new-password', hint: 'At least 10 characters.' })}
        ${errors.form ? html`<p class="field-error">${errors.form}</p>` : ''}
        <button class="button" type="submit">Create account</button>
      </form>
      <p>Already have an account? <a href="/login${nextQuery}">Log in</a></p>
    </section>`,
  });
}

export function loginPage(ctx, { values = {}, error = '', next = '', status = 200 }) {
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : '';
  return layout(ctx, {
    title: 'Log in',
    status,
    body: html`<section class="section narrow">
      <h1 class="page-title">Log in</h1>
      <form class="auth-form" action="/login" method="post">
        ${csrfField(ctx)}<input type="hidden" name="next" value="${next}">
        ${field({ name: 'email', label: 'Email', type: 'email', value: values.email, autocomplete: 'email' })}
        ${field({ name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' })}
        ${error ? html`<p class="field-error" role="alert">${error}</p>` : ''}
        <button class="button" type="submit">Log in</button>
      </form>
      <p>New here? <a href="/signup${nextQuery}">Create an account</a></p>
    </section>`,
  });
}

export function profilePage(ctx, { profile, posts, page }) {
  return layout(ctx, {
    title: profile.username,
    body: html`<section class="section narrow">
      <h1 class="page-title">${profile.username}</h1>
      <p class="topic-fact">Joined ${formatDate(profile.created_at)}</p>
      ${posts.items.length ? posts.items.map(({ post, topic }) => postCard(ctx, post, { topic }))
    : html`<p class="empty-text">No posts yet.</p>`}
      ${pager(`/u/${profile.username}`, {}, page, posts.hasMore)}
    </section>`,
  });
}

export function errorPage(ctx, status, heading, message) {
  return layout(ctx, {
    title: heading,
    status,
    body: html`<section class="section narrow">
      <h1 class="page-title">${heading}</h1>
      <p>${message}</p>
      <p><a href="/">Go to the home page</a></p>
    </section>`,
  });
}
