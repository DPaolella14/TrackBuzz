// Run these while the web server is stopped, so MusicBrainz's one-request-per-second limit is respected.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { Importer } from '../src/importer.js';
import { MusicBrainzClient } from '../src/musicbrainz.js';

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();
const db = openDb(config.databasePath);
const importer = new Importer(db, new MusicBrainzClient({ contact: config.musicBrainzContact }), { log: console.log });

if (command === 'sync') {
  console.log(`Added ${await importer.runSync({ maxNew: config.maxNewAlbumsPerSync })} new releases.`);
} else if (command === 'import' && rest.length) {
  const term = rest.join(' ');
  console.log(`Added ${await importer.importSearchTerm(term)} releases for "${term}".`);
} else {
  console.error('Usage: npm run catalog:sync\n       npm run catalog:import -- "Artist, album, or song"');
  process.exitCode = 1;
}
db.close();
