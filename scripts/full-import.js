// Imports the complete MusicBrainz catalog. Stop the site first. See the README for details.
//   npm run catalog:full-import -- --check     Shows the download size and free space, and changes nothing
//   npm run catalog:full-import                Runs the import
//   --no-genres                                Skips genres, whose license is non-commercial
//   --work-dir=PATH                            Keeps temporary files on another drive
import { loadConfig } from '../src/config.js';
import { ImportStopped, runFullImport } from '../src/full-import.js';

const args = process.argv.slice(2);
const workDir = args.find((arg) => arg.startsWith('--work-dir='))?.split('=').slice(1).join('=');
const config = loadConfig();

try {
  await runFullImport({
    databasePath: config.databasePath,
    port: config.port,
    checkOnly: args.includes('--check'),
    includeGenres: !args.includes('--no-genres'),
    ...(workDir ? { workDir } : {}),
  });
} catch (err) {
  if (!(err instanceof ImportStopped)) throw err;
  console.error(`\n${err.message}`);
  process.exitCode = 1;
}
