import { AsyncLocalStorage } from "node:async_hooks";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function openDatabase() {
  // Tests explicitly pass DB_PATH, which takes precedence over the local .env.
  const postgres = !!process.env.DATABASE_URL && !process.env.DB_PATH;
  let connection,
    cleanup = () => {};
  if (postgres) {
    const { default: pg } = await import("pg");
    pg.types.setTypeParser(20, (value) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number))
        throw Error("Database integer exceeds supported precision");
      return number;
    });
    connection = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
      application_name: "zhajinhua",
      keepAlive: true,
    });
    connection.on("error", (error) => {
      console.error(
        "Database connection lost:",
        error.code || "connection error",
      );
      process.exit(1);
    });
    await connection.connect();
    // One active game coordinator per database. This lock belongs to this exact
    // connection and is automatically released on connection loss/container exit.
    const lock = await connection.query(
      "SELECT pg_try_advisory_lock(1785230952, hashtext(current_schema())) AS acquired",
    );
    if (!lock.rows[0].acquired) {
      await connection.end();
      throw Error("This game database already has an active server.");
    }
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    const path = resolve(
      process.env.DB_PATH || resolve(root, "data/game.sqlite"),
    );
    mkdirSync(dirname(path), { recursive: true });
    const lockPath = path + ".lock";
    const birth = (pid) => {
      if (process.platform !== "linux") return null;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return (
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
        ":" +
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
      );
    };
    if (existsSync(lockPath)) {
      const owner = JSON.parse(readFileSync(lockPath, "utf8"));
      const pid = typeof owner === "number" ? owner : owner.pid;
      if (!Number.isInteger(pid) || pid <= 0)
        throw Error("Invalid database lock file: " + lockPath);
      let running = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") running = false;
      }
      if (running && owner.birth) {
        try {
          running = birth(pid) === owner.birth;
        } catch (error) {
          if (error.code === "ENOENT") running = false;
          else throw error;
        }
      }
      if (running)
        throw Error("This SQLite database already has an active server.");
      unlinkSync(lockPath);
    }
    const owner = JSON.stringify({
      pid: process.pid,
      birth: birth(process.pid),
    });
    writeFileSync(lockPath, owner, { flag: "wx" });
    cleanup = () => {
      try {
        if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
      } catch {}
    };
    process.on("exit", cleanup);
    connection = new DatabaseSync(path);
    connection.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
  }

  // Serial transactions preserve the existing single-room-coordinator model.
  // AsyncLocalStorage prevents other requests from entering an open transaction.
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  function exclusive(work) {
    if (context.getStore()) return work();
    const result = tail.then(() => context.run(true, work));
    tail = result.catch(() => {});
    return result;
  }
  const raw = async (sql, args = []) => {
    if (postgres) {
      let index = 0;
      return (
        await connection.query(
          sql.replace(/\?/g, () => "$" + ++index),
          args,
        )
      ).rows;
    }
    return connection.prepare(sql).all(...args);
  };
  const exec = async (sql) =>
    postgres ? connection.query(sql) : connection.exec(sql);
  const schema = readFileSync(resolve(root, "lib/schema.sql"), "utf8");
  await exec(
    postgres
      ? schema
      : schema.replaceAll("BIGSERIAL PRIMARY KEY", "INTEGER PRIMARY KEY"),
  );
  return {
    kind: postgres ? "PostgreSQL" : "SQLite",
    get: (sql, ...args) => exclusive(async () => (await raw(sql, args))[0]),
    all: (sql, ...args) => exclusive(() => raw(sql, args)),
    run: (sql, ...args) => exclusive(() => raw(sql, args)),
    tx: (fn) =>
      exclusive(async () => {
        await exec(postgres ? "BEGIN" : "BEGIN IMMEDIATE");
        try {
          const result = await fn();
          await exec("COMMIT");
          return result;
        } catch (error) {
          await exec("ROLLBACK");
          throw error;
        }
      }),
    close: () =>
      exclusive(async () => {
        if (postgres) await connection.end();
        else connection.close();
        cleanup();
      }),
  };
}
