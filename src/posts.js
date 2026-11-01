export const TABS = {
  story: {
    label: 'Personal stories',
    empty: 'No stories yet. Tell the first one.',
    action: 'Post story',
    prompt: (name) => `What's your story with ${name}?`,
  },
  concert: {
    label: 'Concerts',
    empty: 'No concert memories yet. Share the first one.',
    action: 'Post concert memory',
    prompt: (name) => `What was it like hearing ${name} live?`,
  },
  tips: {
    label: 'Performance tips',
    empty: 'No tips yet. Share a technique for singing, playing, or producing.',
    action: 'Post tip',
    prompt: (name) => `What's your technique for singing, playing, or producing ${name}?`,
  },
  rating: {
    label: 'Ratings',
    empty: 'No ratings yet. Be the first to weigh in.',
    action: 'Post rating',
    prompt: (name) => `What do you like or dislike about ${name}?`,
  },
};

export const MAX_BODY = 5000;

export function validatePost({ tab, body, rating }) {
  const errors = {};
  const clean = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!clean) errors.body = 'Write something before posting.';
  else if (clean.length > MAX_BODY) errors.body = `Keep it under ${MAX_BODY} characters. You wrote ${clean.length}.`;
  let score = null;
  if (tab === 'rating') {
    if (/^(10|[0-9])$/.test(String(rating ?? ''))) score = Number(rating);
    else errors.rating = 'Choose a rating from 0 to 10.';
  }
  return { errors, body: clean, rating: score };
}

const POST_SELECT = `SELECT posts.id, posts.user_id, posts.topic_type, posts.topic_id, posts.tab, posts.body, posts.rating,
  posts.created_at, posts.edited_at, users.username FROM posts JOIN users ON users.id = posts.user_id`;

export function getPost(db, id) {
  return db.prepare(`${POST_SELECT} WHERE posts.id = ?`).get(id) || null;
}

export function listTopicPosts(db, type, id, tab, { limit = 20, offset = 0 } = {}) {
  const rows = db.prepare(`${POST_SELECT} WHERE topic_type = ? AND topic_id = ? AND tab = ? ORDER BY posts.id DESC LIMIT ? OFFSET ?`)
    .all(type, id, tab, limit + 1, offset);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export function topicStats(db, type, id) {
  const counts = { story: 0, concert: 0, tips: 0, rating: 0 };
  for (const row of db.prepare('SELECT tab, count(*) AS total FROM posts WHERE topic_type = ? AND topic_id = ? GROUP BY tab').all(type, id)) {
    counts[row.tab] = row.total;
  }
  const { average } = db.prepare(`SELECT avg(rating) AS average FROM posts WHERE topic_type = ? AND topic_id = ? AND tab = 'rating'`).get(type, id);
  return { counts, average };
}

export function userRating(db, userId, type, id) {
  return db.prepare(`SELECT id, rating FROM posts WHERE user_id = ? AND topic_type = ? AND topic_id = ? AND tab = 'rating'`).get(userId, type, id) || null;
}

export function createPost(db, { userId, type, topicId, tab, body, rating }) {
  return Number(db.prepare('INSERT INTO posts (user_id, topic_type, topic_id, tab, body, rating) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, type, topicId, tab, body, rating).lastInsertRowid);
}

export function updatePost(db, id, { body, rating }) {
  db.prepare(`UPDATE posts SET body = ?, rating = ?, edited_at = datetime('now') WHERE id = ?`).run(body, rating, id);
}

export function deletePost(db, id) {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}

export function recentPosts(db, limit = 8) {
  return db.prepare(`${POST_SELECT} ORDER BY posts.id DESC LIMIT ?`).all(limit);
}

export function userPosts(db, userId, { limit = 20, offset = 0 } = {}) {
  const rows = db.prepare(`${POST_SELECT} WHERE posts.user_id = ? ORDER BY posts.id DESC LIMIT ? OFFSET ?`).all(userId, limit + 1, offset);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}
