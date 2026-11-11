import { randomBytes } from "node:crypto";
import { buildApp } from "./app.js";
import { createPool } from "./database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = createPool(databaseUrl);
const secret = process.env.JWT_SECRET || randomBytes(32).toString("hex");

try {
  const app = await buildApp({ pool, jwtSecret: secret, logger: true });
  await app.listen({
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "0.0.0.0",
    backlog: 4096,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.close().catch((error: unknown) => {
        app.log.error(error);
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
}
