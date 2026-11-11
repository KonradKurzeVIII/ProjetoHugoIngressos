import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import type { Pool } from "pg";
import { ApiError, isDatabaseUnavailable } from "./errors.js";
import { migrate } from "./database.js";
import { Orders } from "./orders.js";
import { hashPassword, verifyPassword } from "./password.js";
import { registerWeb } from "./web.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

const credentials = {
  type: "object", required: ["username", "password"], additionalProperties: false,
  properties: {
    username: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" },
    password: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

interface Credentials { username: string; password: string }
interface Options { pool: Pool; jwtSecret: string; logger?: boolean }

async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
    if (!/^[1-9]\d*$/.test(request.user.sub)
      || !Number.isSafeInteger(Number(request.user.sub))) throw new Error("Invalid subject");
  } catch {
    throw new ApiError(401, "NAO_AUTORIZADO");
  }
}

export async function buildApp(options: Options): Promise<FastifyInstance> {
  const { pool, jwtSecret } = options;
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must have at least 32 characters");
  await migrate(pool);
  const app = Fastify({
    logger: options.logger ? {
      redact: ["req.headers.authorization"],
    } : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 4096,
    requestTimeout: 0,
    connectionTimeout: 0,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: "HS256", expiresIn: "2h" },
    verify: { algorithms: ["HS256"] },
  });
  const orders = new Orders(pool);
  const dummyHash = await hashPassword("not-a-real-user-password");
  const poolError = (error: Error): void => { app.log.error({ err: error }, "Database connection lost"); };
  pool.on("error", poolError);
  app.addHook("onClose", async () => {
    await orders.drain();
    pool.off("error", poolError);
    await pool.end();
  });

  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: error.errorCode });
    }
    if (error.validation || (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)) {
      return reply.code(400).send({ error: "DADOS_INVALIDOS" });
    }
    app.log.error({ err: error }, "Request failed");
    return reply.code(isDatabaseUnavailable(error) ? 503 : 500)
      .send({ error: isDatabaseUnavailable(error) ? "INDISPONIVEL" : "ERRO_INTERNO" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "NAO_ENCONTRADO" }));
  await registerWeb(app);

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.post<{ Body: Credentials }>("/auth/registrar", {
    schema: { body: credentials },
  }, async (request, reply) => {
    const passwordHash = await hashPassword(request.body.password);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [request.body.username, passwordHash],
    );
    if (!result.rowCount) throw new ApiError(409, "USUARIO_EXISTENTE");
    return reply.code(201).send();
  });

  app.post<{ Body: Credentials }>("/auth/login", {
    schema: { body: credentials },
  }, async (request) => {
    const result = await pool.query<{ id: number; password_hash: string }>(
      "SELECT id, password_hash FROM users WHERE username = $1", [request.body.username],
    );
    const user = result.rows[0];
    const matches = await verifyPassword(request.body.password, user?.password_hash ?? dummyHash);
    if (!user || !matches) throw new ApiError(401, "NAO_AUTORIZADO");
    return { token: app.jwt.sign({ sub: String(user.id) }) };
  });

  await app.register(async (protectedApp) => {
    protectedApp.addHook("onRequest", authenticate);

    protectedApp.get("/pedidos", async (request) => ({
      pedidos: await orders.list(Number(request.user.sub)),
    }));

    protectedApp.post<{ Body: { showId: number } }>("/pedidos", {
      schema: { body: {
        type: "object", required: ["showId"], additionalProperties: false,
        properties: { showId: { type: "integer", const: 7 } },
      } },
    }, async (request, reply) => {
      const order = await orders.create(Number(request.user.sub));
      return reply.code(201).send(order);
    });

    for (const action of ["reservar", "cancelar"] as const) {
      protectedApp.post<{ Params: { id: string } }>(`/pedidos/:id/${action}`, async (request, reply) => {
        const id = Number(request.params.id);
        if (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(id) || id > 2147483647) {
          throw new ApiError(404, "NAO_ENCONTRADO");
        }
        const order = await orders.mutate(Number(request.user.sub), id, action);
        if (action === "reservar") reply.header("X-Lote", "7F3A");
        return reply.code(200).send(order);
      });
    }
    protectedApp.get("/pool", async () => orders.availability());
  });
  return app;
}
