const { readFile, readdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
  try {
    const { rows } = await pool.query("SELECT to_regclass('machines') AS core");
    if (!rows[0].core) {
      await pool.query(await readFile(resolve(__dirname, '../infra/migrations/001_core.sql'), 'utf8'));
    }
    const migrations = (await readdir(resolve(__dirname, '../infra/migrations')))
      .filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
    for (const filename of migrations) {
      const version = Number(filename.slice(0, 3));
      // Migration 001 is applied above on a fresh database. On an existing
      // database its schema is already present, so it must never run again.
      if (version === 1) continue;
      await pool.query(await readFile(resolve(__dirname, '../infra/migrations', filename), 'utf8'));
    }
  } finally {
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
