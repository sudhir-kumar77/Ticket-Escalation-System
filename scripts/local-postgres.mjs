import EmbeddedPostgres from 'embedded-postgres';
import path from 'path';
import fs from 'fs';

const dataDir = path.resolve('./.pgdata');
const isFirstRun = !fs.existsSync(dataDir);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port: 5432,
  user: 'postgres',
  password: 'password',
  persistent: true,
});

if (isFirstRun) {
  console.log('Initialising PostgreSQL cluster...');
  await pg.initialise();
}

console.log('Starting PostgreSQL server on port 5432...');
await pg.start();
console.log('PostgreSQL started successfully!');

// Ensure nvara user and nvara database exist
const client = pg.getPgClient();
await client.connect();

const userRes = await client.query("SELECT 1 FROM pg_roles WHERE rolname='nvara'");
if (userRes.rowCount === 0) {
  console.log('Creating role nvara...');
  await client.query("CREATE ROLE nvara WITH LOGIN SUPERUSER PASSWORD 'nvara_local_dev_only'");
}

const dbRes = await client.query("SELECT 1 FROM pg_database WHERE datname='nvara'");
if (dbRes.rowCount === 0) {
  console.log('Creating database nvara...');
  await client.query("CREATE DATABASE nvara OWNER nvara");
}

await client.end();
console.log('Database and user ready!');

// Keep alive
setInterval(() => {}, 1000 * 60 * 60);
