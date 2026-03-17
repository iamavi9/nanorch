import { pool } from "./db";

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "add_ollama_provider_enum",
    sql: `ALTER TYPE "provider" ADD VALUE IF NOT EXISTS 'ollama'`,
  },
  {
    name: "add_orchestrators_base_url",
    sql: `ALTER TABLE "orchestrators" ADD COLUMN IF NOT EXISTS "base_url" text`,
  },
  {
    name: "add_agents_sandbox_timeout_seconds",
    sql: `ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "sandbox_timeout_seconds" integer`,
  },
  {
    name: "add_integration_mode",
    sql: `ALTER TABLE "cloud_integrations" ADD COLUMN IF NOT EXISTS "integration_mode" text DEFAULT 'tool' NOT NULL`,
  },
];

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _nanoorch_migrations (
        name text PRIMARY KEY,
        applied_at timestamp DEFAULT now()
      )
    `);

    for (const migration of MIGRATIONS) {
      const { rows } = await client.query(
        `SELECT name FROM _nanoorch_migrations WHERE name = $1`,
        [migration.name],
      );
      if (rows.length > 0) continue;

      await client.query(migration.sql);
      await client.query(
        `INSERT INTO _nanoorch_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`,
        [migration.name],
      );
      console.log(`[db] Applied migration: ${migration.name}`);
    }
  } finally {
    client.release();
  }
}
