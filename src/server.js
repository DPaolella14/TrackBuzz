import { createServer } from 'node:http';
import { purgeExpiredSessions } from './auth.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Importer, startCatalogWorker } from './importer.js';
import { LiveSearch } from './live-search.js';
import { MusicBrainzClient } from './musicbrainz.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const mb = new MusicBrainzClient({ contact: config.musicBrainzContact });
const importer = new Importer(db, mb, { log: console.log });
const server = createServer(createApp({ db, config, importer, live: new LiveSearch(db, mb) }));

purgeExpiredSessions(db);
const purgeTimer = setInterval(() => purgeExpiredSessions(db), 3600000);
purgeTimer.unref();

let stopWorker = () => {};
if (config.catalogSync) {
  stopWorker = startCatalogWorker(db, importer, {
    syncEveryHours: config.syncEveryHours,
    maxNew: config.maxNewAlbumsPerSync,
  });
}

server.listen(config.port, () => {
  console.log(`TrackBuzz is running at http://localhost:${config.port}`);
});

function shutdown() {
  stopWorker();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
