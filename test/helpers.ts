import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join, relative, isAbsolute } from "node:path";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/database.js";
import { httpClient } from "../scripts/http-client.mjs";

export type HttpResult = Awaited<ReturnType<ReturnType<typeof httpClient>["call"]>>;

async function unusedPort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolveListening, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolveListening);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No available test port");
  await new Promise<void>((resolveClosed, reject) => {
    socket.close((error) => error ? reject(error) : resolveClosed());
  });
  return address.port;
}

export async function createHarness() {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let stopPostgres: (() => Promise<void>) | undefined;
  if (!databaseUrl) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const toolsRoot = resolve(".tools");
    await mkdir(toolsRoot, { recursive: true });
    const databaseDir = await mkdtemp(join(toolsRoot, "pg-test-"));
    const relativePath = relative(toolsRoot, databaseDir);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Unsafe temporary PostgreSQL directory");
    }
    const port = await unusedPort();
    const password = randomBytes(24).toString("hex");
    const embedded = new EmbeddedPostgres({
      databaseDir, port, user: "postgres", password, persistent: false,
      authMethod: "scram-sha-256", onLog: () => {}, onError: () => {},
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-h", "127.0.0.1"],
    });
    await embedded.initialise();
    await embedded.start();
    stopPostgres = () => embedded.stop();
    databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  }

  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const connection = new URL(databaseUrl);
  const options = connection.searchParams.get("options") ?? "";
  connection.searchParams.set("options", `${options} -c search_path=${schema},public`.trim());
  const pool = createPool(connection.toString());
  try {
    const app = await buildApp({ pool, jwtSecret: randomBytes(32).toString("hex") });
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1", backlog: 4096 });
    const http = httpClient(baseUrl);
    return {
      app, pool, http, baseUrl,
      async close(): Promise<void> {
        http.close();
        await app.close();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
        await stopPostgres?.();
      },
    };
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await stopPostgres?.();
    throw error;
  }
}
