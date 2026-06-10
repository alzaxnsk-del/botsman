import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { logger } from '../logger.js';

/**
 * Database for generated services (§3): ONE shared Postgres container
 * ("botsman-postgres") with a separate database + role per project.
 * Chosen over per-project containers because it is simpler to operate and
 * cheaper on a 4 GB VPS; isolation is enforced by per-project credentials
 * (documented in README). The postgres container is attached to each
 * project's private network so services never share a network with each other.
 */
export const PG_CONTAINER = 'botsman-postgres';
export const PG_SUPERUSER = 'botsman';

export interface ProjectDb {
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

export function dbNamesForSlug(slug: string): { dbName: string; dbUser: string } {
  const safe = slug.replace(/-/g, '_').slice(0, 40);
  return { dbName: `app_${safe}`, dbUser: `u_${safe}` };
}

export function generatePassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

/** Env vars injected into service containers (never committed to git). */
export function dbEnvFor(db: ProjectDb): Record<string, string> {
  return {
    PGHOST: PG_CONTAINER,
    PGPORT: '5432',
    PGDATABASE: db.dbName,
    PGUSER: db.dbUser,
    PGPASSWORD: db.dbPassword,
    DATABASE_URL: `postgres://${db.dbUser}:${db.dbPassword}@${PG_CONTAINER}:5432/${db.dbName}`,
  };
}

export class PostgresAdmin {
  constructor(private docker: Dockerode, private superPassword: string) {}

  /** Run psql inside the postgres container as superuser. Returns trimmed stdout (tuples-only). */
  private async psql(sql: string, database = 'postgres'): Promise<string> {
    const container = this.docker.getContainer(PG_CONTAINER);
    const exec = await container.exec({
      Cmd: ['psql', '-v', 'ON_ERROR_STOP=1', '-tA', '-U', PG_SUPERUSER, '-d', database, '-c', sql],
      Env: [`PGPASSWORD=${this.superPassword}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const { stdout, stderr } = await collectExecStream(this.docker, stream);
    const inspect = await exec.inspect();
    if (inspect.ExitCode !== 0) {
      throw new Error(`psql failed (${inspect.ExitCode}): ${(stderr || stdout).slice(0, 500)}`);
    }
    return stdout.trim();
  }

  async ensureProjectDb(db: ProjectDb): Promise<void> {
    const ident = (s: string) => `"${s.replace(/"/g, '')}"`;
    const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
    // CREATE ROLE/DATABASE are not idempotent — guard with catalog checks.
    await this.psql(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(db.dbUser)}) THEN
        CREATE ROLE ${ident(db.dbUser)} LOGIN PASSWORD ${literal(db.dbPassword)};
      ELSE
        ALTER ROLE ${ident(db.dbUser)} WITH LOGIN PASSWORD ${literal(db.dbPassword)};
      END IF;
    END $$;`);
    const exists = await this.psql(
      `SELECT 1 FROM pg_database WHERE datname = ${literal(db.dbName)};`,
    );
    if (exists === '') {
      await this.psql(`CREATE DATABASE ${ident(db.dbName)} OWNER ${ident(db.dbUser)};`);
    }
    // Lock the database down to its owner only (cross-project isolation).
    await this.psql(`REVOKE ALL ON DATABASE ${ident(db.dbName)} FROM PUBLIC;`);
    await this.psql(`GRANT ALL ON DATABASE ${ident(db.dbName)} TO ${ident(db.dbUser)};`);
    logger.info('project db ensured', { db: db.dbName });
  }

  async dropProjectDb(db: { dbName: string; dbUser: string }): Promise<void> {
    const ident = (s: string) => `"${s.replace(/"/g, '')}"`;
    await this.psql(`DROP DATABASE IF EXISTS ${ident(db.dbName)} WITH (FORCE);`);
    await this.psql(`DROP ROLE IF EXISTS ${ident(db.dbUser)};`);
  }
}

/** Docker exec streams are multiplexed (8-byte frame headers) — demux properly. */
function collectExecStream(
  docker: Dockerode,
  stream: NodeJS.ReadableStream,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const outPT = new PassThrough().on('data', (c: Buffer) => out.push(c));
    const errPT = new PassThrough().on('data', (c: Buffer) => err.push(c));
    docker.modem.demuxStream(stream, outPT, errPT);
    stream.on('end', () =>
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    stream.on('error', reject);
  });
}
