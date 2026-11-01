import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export const STATIC_FILES = new Map(readdirSync(PUBLIC_DIR).map((name) => {
  const body = readFileSync(join(PUBLIC_DIR, name));
  return [`/${name}`, {
    body,
    type: MIME[extname(name)] || 'application/octet-stream',
    version: createHash('sha256').update(body).digest('hex').slice(0, 12),
  }];
}));

// Each URL includes a fingerprint of the file, so browsers fetch a new copy as soon as it changes.
export function assetUrl(path) {
  return `${path}?v=${STATIC_FILES.get(path).version}`;
}

export function assetCacheControl(asset, requestedVersion) {
  return requestedVersion === asset.version ? 'public, max-age=31536000, immutable' : 'no-cache';
}
