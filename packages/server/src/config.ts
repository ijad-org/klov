import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface S3Config {
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolSize: number;
  publicUrl?: string;
  ingestToken?: string;
  adminToken?: string;
  storage: { kind: 'fs'; dir: string } | ({ kind: 's3' } & S3Config);
  pubsub: 'postgres' | 'memory';
  staleRunMinutes: number;
  retentionDays: number;
  maxAttachmentBytes: number;
  webDir?: string;
  traceViewerDir?: string;
  logLevel: string;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Expected an integer, got "${value}"`);
  return parsed;
}

function existingDir(...candidates: (string | undefined)[]): string | undefined {
  return candidates.find((c): c is string => !!c && existsSync(c));
}

/** Playwright ships its trace viewer as static files; Klov serves them so traces open in one click. */
function findTraceViewer(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('playwright-core/package.json');
    return existingDir(join(dirname(pkg), 'lib/vite/traceViewer'));
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const here = dirname(fileURLToPath(import.meta.url));
  const storageKind = (env.KLOV_STORAGE ?? 'fs').toLowerCase();
  let storage: Config['storage'];
  if (storageKind === 's3') {
    if (!env.KLOV_S3_BUCKET) throw new Error('KLOV_S3_BUCKET is required when KLOV_STORAGE=s3');
    storage = {
      kind: 's3',
      bucket: env.KLOV_S3_BUCKET,
      prefix: env.KLOV_S3_PREFIX ?? 'klov/',
      region: env.KLOV_S3_REGION ?? env.AWS_REGION,
      endpoint: env.KLOV_S3_ENDPOINT,
      forcePathStyle: env.KLOV_S3_FORCE_PATH_STYLE === 'true',
    };
  } else if (storageKind === 'fs') {
    storage = { kind: 'fs', dir: resolve(env.KLOV_STORAGE_DIR ?? '.klov-data/attachments') };
  } else {
    throw new Error(`Unknown KLOV_STORAGE "${storageKind}" (expected "fs" or "s3")`);
  }

  const pubsub = (env.KLOV_PUBSUB ?? 'postgres').toLowerCase();
  if (pubsub !== 'postgres' && pubsub !== 'memory') throw new Error(`Unknown KLOV_PUBSUB "${pubsub}"`);

  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://klov:klov@localhost:5432/klov',
    dbPoolSize: int(env.KLOV_DB_POOL_SIZE, 20),
    publicUrl: env.KLOV_PUBLIC_URL?.replace(/\/+$/, ''),
    ingestToken: env.KLOV_INGEST_TOKEN || undefined,
    adminToken: env.KLOV_ADMIN_TOKEN || undefined,
    storage,
    pubsub,
    staleRunMinutes: int(env.KLOV_STALE_RUN_MINUTES, 30),
    retentionDays: int(env.KLOV_RETENTION_DAYS, 0),
    maxAttachmentBytes: int(env.KLOV_MAX_ATTACHMENT_MB, 512) * 1024 * 1024,
    webDir: existingDir(env.KLOV_WEB_DIR, join(here, '../../web/dist'), join(here, '../web')),
    traceViewerDir: existingDir(env.KLOV_TRACE_VIEWER_DIR) ?? findTraceViewer(),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
