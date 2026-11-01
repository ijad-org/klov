// Copies Playwright's trace viewer (shipped inside playwright-core) into public/,
// so traces open inside the dashboard instead of being downloaded.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve('playwright-core/package.json')), 'lib/vite/traceViewer');
const target = join(dirname(fileURLToPath(import.meta.url)), '../public/trace-viewer');
if (!existsSync(source)) {
  console.error(`trace viewer not found at ${source}`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copied Playwright trace viewer to ${target}`);
