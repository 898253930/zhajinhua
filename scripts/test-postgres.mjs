import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const child = spawn(process.execPath, ["--test", "tests/server.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL },
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
