import EmbeddedPostgres from "embedded-postgres";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

// Development fallback for hosts without Docker. Production still uses Compose.
const toolsDir = resolve(".tools");
const databaseDir = resolve(toolsDir, "local-postgres");
const credentialsPath = resolve(toolsDir, "local-credentials.json");
await mkdir(toolsDir, { recursive: true });
let credentials;
try {
  credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  credentials = {
    password: randomBytes(24).toString("hex"),
    jwtSecret: randomBytes(32).toString("hex"),
  };
  await writeFile(credentialsPath, JSON.stringify(credentials), { flag: "wx", mode: 0o600 });
}
const postgres = new EmbeddedPostgres({
  databaseDir, port: 54329, user: "postgres", password: credentials.password,
  authMethod: "scram-sha-256", persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {}, onError: (error) => console.error(error),
});
try {
  await access(resolve(databaseDir, "PG_VERSION"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await postgres.initialise();
}
await postgres.start();
const server = spawn(process.execPath, ["dist/server.js"], {
  stdio: "inherit", windowsHide: true,
  env: {
    ...process.env,
    DATABASE_URL: `postgres://postgres:${credentials.password}@127.0.0.1:54329/postgres`,
    JWT_SECRET: credentials.jwtSecret,
    HOST: "127.0.0.1", PORT: "8080",
  },
});
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await postgres.stop();
  process.exitCode = code;
}
server.once("error", async (error) => {
  console.error(error);
  await stop(1);
});
server.once("exit", async (code) => { await stop(code ?? 1); });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { server.kill("SIGTERM"); });
}
