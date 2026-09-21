import { randomUUID } from 'crypto';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../db/schema';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'path';

export type TestDbContext = {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  testRunId: string;
};

function getTestDatabaseUrl() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL is required to run database tests'
    );
  }

  return databaseUrl;
}

export async function createTestDb(): Promise<TestDbContext> {
  const testRunId = randomUUID();
  const testDbUrl = getTestDatabaseUrl();

  const pool = new Pool({
    connectionString: testDbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  await migrate(db, { migrationsFolder: join(__dirname, '../db/drizzle') });
  await pool.query('TRUNCATE TABLE "todos", "users" RESTART IDENTITY CASCADE');

  return { pool, db, testRunId };
}

export async function destroyTestDb({ pool }: TestDbContext) {
  await pool.query('TRUNCATE TABLE "todos", "users" RESTART IDENTITY CASCADE');

  await pool.end();
}