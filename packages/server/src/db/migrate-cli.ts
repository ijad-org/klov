import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const config = loadConfig();
const db = createPool(config.databaseUrl, 2);
try {
  const applied = await migrate(db, (msg) => console.log(msg));
  console.log(applied.length ? `Applied ${applied.length} migration(s)` : 'Database is up to date');
} finally {
  await db.end();
}
