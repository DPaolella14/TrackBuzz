// The site works without this file. It adds search suggestions, delete confirmation, and cover art fallback.

document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement && event.target.closest('.cover')) event.target.remove();
}, true);

document.addEventListener('submit', (event) => {
  const message = event.target.dataset?.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

for (const form of document.querySelectorAll('form[data-suggest]')) {
  const input = form.querySelector('input[type="search"]');
  const list = form.querySelector('.suggestions');
  let timer;
  let active = -1;
  let requestId = 0;

  const options = () => [...list.querySelectorAll('[role="option"]')];
  const close = () => {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const highlight = (index) => {
    const items = options();
    items.forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    active = index;
    if (items[index]) input.setAttribute('aria-activedescendant', items[index].id);
    else input.removeAttribute('aria-activedescendant');
  };

  async function load() {
    const q = input.value.trim();
    const id = ++requestId;
    if (q.length < 2) return close();
    try {
      const response = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (!response.ok) return close();
      const { items } = await response.json();
      if (id !== requestId) return undefined;
      list.replaceChildren(...items.map((item, index) => {
        const li = document.createElement('li');
        li.id = `${list.id}-${index}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        const link = document.createElement('a');
        link.href = item.url;
        link.tabIndex = -1;
        const name = document.createElement('strong');
        name.textContent = item.name;
        const context = document.createElement('span');
        context.textContent = item.context;
        link.append(name, context);
        li.append(link);
        return li;
      }));
      active = -1;
      list.hidden = !items.length;
      input.setAttribute('aria-expanded', String(Boolean(items.length)));
    } catch {
      close();
    }
    return undefined;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 150);
  });
  input.addEventListener('keydown', (event) => {
    if (list.hidden) return;
    const items = options();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) close();
  });
}
