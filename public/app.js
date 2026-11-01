// The site works without this file. It adds live search, delete confirmation, cover art fallback,
// and refreshes pages that are waiting on music to be added.

const LIVE_KINDS = ['artist', 'album', 'song'];

document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement) {
    if (event.target.closest('.cover')) event.target.remove();
    else if (event.target.closest('.thumb')) event.target.remove();
  }
}, true);

document.addEventListener('submit', (event) => {
  const message = event.target.dataset?.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

const refresher = document.querySelector('[data-auto-refresh]');
if (refresher) {
  setTimeout(function check() {
    // Never reload over something a person is writing.
    const typing = [...document.querySelectorAll('textarea, input[type="search"]')].some((field) => field.value.trim());
    if (typing) setTimeout(check, 8000);
    else window.location.reload();
  }, 8000);
}

function resultContent(item) {
  const thumb = document.createElement('span');
  thumb.className = `thumb thumb-${item.kind || 'other'}`;
  thumb.setAttribute('aria-hidden', 'true');
  if (item.kind === 'artist') thumb.textContent = item.name.trim().charAt(0).toUpperCase();
  if (item.cover) {
    const image = document.createElement('img');
    image.src = item.cover;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    thumb.append(image);
  }
  const text = document.createElement('span');
  text.className = 'result-text';
  const name = document.createElement('strong');
  name.textContent = item.name;
  const context = document.createElement('span');
  context.textContent = item.context;
  text.append(name, context);
  return [thumb, text];
}

async function fetchItems(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`Search answered ${response.status}`);
  const data = await response.json();
  if (data.unavailable) throw new Error('MusicBrainz is unavailable');
  return data.items || [];
}

for (const form of document.querySelectorAll('form[data-suggest]')) {
  const input = form.querySelector('input[type="search"]');
  const list = form.querySelector('.suggestions');
  let localTimer;
  let liveTimer;
  let controller = null;
  let active = -1;
  let shown = new Set();

  const options = () => [...list.querySelectorAll('[role="option"]')];
  const status = () => list.querySelector('.suggest-status');

  function open() {
    const hasContent = list.children.length > 0;
    list.hidden = !hasContent;
    input.setAttribute('aria-expanded', String(hasContent));
  }
  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(index) {
    const items = options();
    items.forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    active = index;
    if (items[index]) {
      input.setAttribute('aria-activedescendant', items[index].id);
      items[index].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }
  function addItems(items) {
    const fresh = items.filter((item) => !shown.has(item.url) && shown.add(item.url));
    const before = status();
    for (const item of fresh) {
      const li = document.createElement('li');
      li.id = `${list.id}-${list.children.length}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const link = document.createElement('a');
      link.href = item.url;
      link.tabIndex = -1;
      link.rel = 'nofollow';
      link.append(...resultContent(item));
      li.append(link);
      list.insertBefore(li, before);
    }
    open();
  }
  function setStatus(text) {
    let row = status();
    if (!text) {
      row?.remove();
    } else {
      if (!row) {
        row = document.createElement('li');
        row.className = 'suggest-status';
        row.setAttribute('role', 'presentation');
        list.append(row);
      }
      row.textContent = text;
    }
    open();
  }

  async function runLocal(q, signal) {
    const items = await fetchItems(`/api/suggest?q=${encodeURIComponent(q)}`, signal);
    if (!signal.aborted) addItems(items);
  }

  async function runLive(q, signal) {
    setStatus('Searching all music');
    let failed = false;
    for (const kind of LIVE_KINDS) {
      if (signal.aborted) return;
      try {
        const items = await fetchItems(`/api/live?kind=${kind}&q=${encodeURIComponent(q)}`, signal);
        if (!signal.aborted) addItems(items);
      } catch {
        failed = true;
      }
    }
    if (signal.aborted) return;
    if (failed) setStatus('Some results couldn\'t load. Try again in a moment.');
    else setStatus(options().length ? '' : `No matches for "${q}" yet. Keep typing or check the spelling.`);
  }

  input.addEventListener('input', () => {
    clearTimeout(localTimer);
    clearTimeout(liveTimer);
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const q = input.value.trim();
    if (!q) {
      list.replaceChildren();
      shown = new Set();
      close();
      return;
    }
    localTimer = setTimeout(() => {
      // Results swap in together, so the list doesn't flash empty between letters.
      list.replaceChildren();
      shown = new Set();
      active = -1;
      runLocal(q, signal).catch(() => {});
    }, 60);
    if (q.length >= 2) {
      liveTimer = setTimeout(() => runLive(q, signal), 300);
    }
  });
  input.addEventListener('keydown', (event) => {
    if (list.hidden) return;
    const items = options();
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight((active + step + items.length) % items.length);
    } else if (event.key === 'Enter' && items[active]) {
      event.preventDefault();
      window.location.href = items[active].querySelector('a').href;
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('focus', () => {
    if (list.children.length) open();
  });
  list.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (link) setStatus('Opening');
  });
  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) close();
  });
}

const livePanel = document.querySelector('[data-live-results]');
if (livePanel) {
  const q = livePanel.dataset.liveResults;
  const target = q.trim().toLowerCase();
  const list = livePanel.querySelector('.result-list');
  const note = livePanel.querySelector('.live-status');
  const seen = new Set([...list.querySelectorAll('a')].map((link) => link.getAttribute('href')));
  let failed = false;
  note.textContent = 'Searching';
  (async () => {
    for (const kind of livePanel.dataset.liveKinds.split(',')) {
      try {
        for (const item of await fetchItems(`/api/live?kind=${kind}&q=${encodeURIComponent(q)}`)) {
          if (!seen.has(item.url)) {
            seen.add(item.url);
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'result';
            link.href = item.url;
            link.rel = 'nofollow';
            link.append(...resultContent(item));
            li.append(link);
            // An exact name is almost certainly what the person meant, so it goes to the top.
            if (item.name.toLowerCase() === target) list.prepend(li);
            else list.append(li);
          }
        }
      } catch {
        failed = true;
      }
    }
    if (failed) note.textContent = 'Some results couldn\'t load. Try again in a moment.';
    else note.textContent = list.children.length ? '' : `Nothing matches "${q}". Check the spelling or try fewer words.`;
  })();
}
