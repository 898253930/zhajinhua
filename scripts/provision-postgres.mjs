import pg from "pg";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const configPath = process.argv[2];
if (!configPath)
  throw Error("Usage: node scripts/provision-postgres.mjs PRIVATE_CONFIG.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const database = config.targetDatabase || "zhajinhua";
const role = config.targetRole || "zhajinhua_app";
for (const name of [database, role])
  if (!/^[a-z][a-z0-9_]{0,50}$/.test(name))
    throw Error("Invalid database or role name");
const envPath = resolve(".env");
if (existsSync(envPath))
  throw Error(".env already exists; refusing to overwrite credentials.");
const client = new pg.Client({
  host: config.host,
  port: config.port || 5432,
  database: config.database || "postgres",
  user: config.user,
  password: config.password,
  ssl: config.ssl || false,
  connectionTimeoutMillis: 10000,
});
try {
  await client.connect();
  console.log("PostgreSQL connected.");
  if (
    (
      await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        database,
      ])
    ).rowCount
  )
    throw Error("Target database already exists; refusing to modify it.");
  if (
    (await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]))
      .rowCount
  )
    throw Error("Target role already exists; refusing to modify it.");
  const password = randomBytes(32).toString("hex");
  await client.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  await client.query(
    `CREATE DATABASE "${database}" OWNER "${role}" ENCODING 'UTF8' TEMPLATE template0`,
  );
  const url = `postgresql://${role}:${password}@${config.host}:${config.port || 5432}/${database}`;
  writeFileSync(
    envPath,
    `# Private local configuration; excluded from Git and Docker build context.\nHOST=0.0.0.0\nPORT=3000\nDATABASE_URL=${url}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Created database ${database} and restricted role ${role}. Credentials saved to .env (not printed).`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
