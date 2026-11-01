import { existsSync } from 'node:fs';

export function loadConfig(env = process.env) {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');
  const production = env.NODE_ENV === 'production';
  return {
    production,
    port: Number(env.PORT || 3000),
    databasePath: env.DATABASE_PATH || 'data/trackbuzz.db',
    // Only set TRUST_PROXY when the app runs behind a proxy you control.
    trustProxy: env.TRUST_PROXY === '1',
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' : production,
    catalogSync: env.CATALOG_SYNC !== 'off',
    syncEveryHours: Number(env.CATALOG_SYNC_HOURS || 24),
    maxNewAlbumsPerSync: Number(env.CATALOG_MAX_NEW_PER_SYNC || 200),
    musicBrainzContact: env.MUSICBRAINZ_CONTACT || 'https://github.com/DPaolella14/TrackBuzz',
  };
}
