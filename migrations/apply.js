const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

function loadEnv() {
  const backendEnvPath = path.resolve(__dirname, '..', '.env');
  const rootEnvPath = path.resolve(__dirname, '..', '..', '.env');
  dotenv.config({ path: backendEnvPath });
  dotenv.config({ path: rootEnvPath, override: false });
}

loadEnv();

async function runMigrations() {
  const migrationsDir = path.resolve(__dirname);
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL or POSTGRES_URL must be set in the environment');
    process.exit(1);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      console.log('Running migration:', file);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
    }
    console.log('Migrations applied successfully');
  } catch (e) {
    console.error('Migration error:', e.message || e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

runMigrations().catch(err => { console.error(err); process.exit(1); });
