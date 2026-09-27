import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../lib/database.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
if (process.env.DB_PATH)
  throw Error("Unset DB_PATH before PostgreSQL migration");
const source = resolve(process.argv[2] || "data/game.sqlite");
if (!existsSync(source)) throw Error("Source SQLite database does not exist");
const sqlite = new DatabaseSync(source, { readOnly: true });
const target = await openDatabase();
const tables = [
  "users",
  "sessions",
  "accounts",
  "transactions",
  "entries",
  "rooms",
  "history",
  "commands",
  "audit",
  "settings",
];
try {
  sqlite.exec("BEGIN");
  await target.tx(async () => {
    for (const table of ["users", "transactions", "rooms", "history"]) {
      const row = await target.get(`SELECT COUNT(*) AS count FROM ${table}`);
      if (row.count)
        throw Error("Target database contains game data; migration aborted");
    }
    await target.run("DELETE FROM accounts");
    await target.run("DELETE FROM settings");
    for (const table of tables) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const keys = Object.keys(row);
        await target.run(
          `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          ...Object.values(row),
        );
      }
      console.log(`${table}: ${rows.length} rows migrated`);
    }
    for (const table of ["entries", "audit"]) {
      await target.run(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`,
      );
    }
    const mismatch = await target.all(
      "SELECT a.id FROM accounts a LEFT JOIN entries e ON a.id=e.account_id GROUP BY a.id HAVING a.balance<>COALESCE(SUM(e.amount),0)",
    );
    if (mismatch.length) throw Error("Ledger mismatch; migration rolled back");
  });
  sqlite.exec("COMMIT");
  console.log("Migration complete. Original SQLite file was not modified.");
} finally {
  sqlite.close();
  await target.close();
}
