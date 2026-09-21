import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'path';

const ADMIN_DB_URL = process.env.ADMIN_DB_URL;
const TODOS_URL = process.env.DATABASE_URL;
const DB_NAME = TODOS_URL?.split('/').pop();

async function dropAndCreateDatabase() {
  const adminPool = new Pool({ connectionString: ADMIN_DB_URL });

  await adminPool.query(
    `
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()
    `,
    [DB_NAME]
  );
  await adminPool.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await adminPool.query(`CREATE DATABASE "${DB_NAME}"`);
  await adminPool.end();
}

async function runMigrations() {
  const pool = new Pool({ connectionString: TODOS_URL });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  await migrate(db, { migrationsFolder: join(__dirname, '../src/db/drizzle') });
  await pool.end();
}

async function runSeed() {
  const { execSync } = await import('child_process');
  execSync('npm run db:seed', { stdio: 'inherit' });
}

async function main() {
  console.log('Dropping & recreating database');
  await dropAndCreateDatabase();

  console.log('Running migrations...');
  await runMigrations();

  console.log('seeding database...');
  await runSeed();

  console.log('database reset complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});