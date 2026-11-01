import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

async function derive(password, salt, n = N, r = R, p = P) {
  return scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 128 * n * r * 2 });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

// A missing account still does the same work, so response time doesn't reveal which emails exist.
export async function verifyPassword(password, stored) {
  const [, n, r, p, salt, expected] = (stored || DUMMY_HASH).split('$');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  const match = timingSafeEqual(key, Buffer.from(expected, 'base64'));
  return Boolean(stored) && match;
}

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_MAX_AGE * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expires);
  return token;
}

export function userFromSession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT users.id, users.username FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());
  return row ? { id: row.id, username: row.username } : null;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

export function validateSignup({ username, email, password }) {
  const errors = {};
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    errors.username = 'Use 3 to 24 letters, numbers, or underscores.';
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (password.length < 10 || password.length > 200) {
    errors.password = 'Use at least 10 characters.';
  }
  return errors;
}

export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  // Counts this attempt and returns false once the key is over its limit.
  allow(key, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 50000) this.prune(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  prune(now) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
