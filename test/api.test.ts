import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { createHarness, type HttpResult } from "./helpers.js";
import { warmClients } from "../scripts/http-client.mjs";
import { hashPassword } from "../src/password.js";
import { fifoEvents, type FifoEvent } from "../src/fifo.js";
import { transaction } from "../src/database.js";
import { Orders } from "../src/orders.js";

let harness: Awaited<ReturnType<typeof createHarness>>;
let fixtureHash: string;
let databaseVersion: string;

before(async () => {
  harness = await createHarness();
  fixtureHash = await hashPassword("senha123");
  databaseVersion = (await harness.pool.query<{ version: string }>("SELECT version()"))
    .rows[0]!.version;
});
after(async () => { await harness?.close(); });
beforeEach(async () => {
  await harness.pool.query("TRUNCATE orders, users RESTART IDENTITY");
});

function expectError(result: HttpResult, status: number, error: string): void {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { error });
  assert.equal(result.headers["x-lote"], undefined);
}

async function fixtures(count: number) {
  const users = await harness.pool.query<{ id: number }>(
    `INSERT INTO users (username, password_hash)
     SELECT 'user-' || i, $1 FROM generate_series(1, $2::int) i RETURNING id`,
    [fixtureHash, count],
  );
  return users.rows.map(({ id }) => ({ id, token: harness.app.jwt.sign({ sub: String(id) }) }));
}

async function carts(userIds: number[]) {
  const result = await harness.pool.query<{ id: number; user_id: number }>(
    `INSERT INTO orders (user_id, show_id)
     SELECT id, 7 FROM unnest($1::int[]) id RETURNING id, user_id`, [userIds],
  );
  return result.rows;
}

async function checkDatabaseInvariants(): Promise<number> {
  const total = await harness.pool.query<{ occupied: number }>(
    "SELECT count(*)::int AS occupied FROM orders WHERE status = 'RESERVADO'",
  );
  const occupied = total.rows[0]!.occupied;
  assert.ok(occupied >= 0 && occupied <= 100);
  const violations = await harness.pool.query(
    "SELECT user_id FROM orders WHERE status = 'RESERVADO' GROUP BY user_id HAVING count(*) > 2",
  );
  assert.equal(violations.rowCount, 0);
  return occupied;
}

test("authentication, strict validation and exact public contracts", async () => {
  const { http } = harness;
  expectError(await http.call("POST", "/auth/registrar", undefined, {}), 400, "DADOS_INVALIDOS");
  const body = { username: "joao", password: "senha123" };
  assert.equal((await http.call("POST", "/auth/registrar", undefined, body)).status, 201);
  expectError(await http.call("POST", "/auth/registrar", undefined, body), 409, "USUARIO_EXISTENTE");
  expectError(await http.call("POST", "/auth/login", undefined, { ...body, password: "wrong" }), 401, "NAO_AUTORIZADO");
  expectError(await http.call("POST", "/auth/login", undefined, { ...body, username: "missing" }), 401, "NAO_AUTORIZADO");
  const login = await http.call("POST", "/auth/login", undefined, body);
  assert.equal(login.status, 200);
  assert.equal(typeof login.body.token, "string");
  const token = login.body.token as string;
  for (const [method, path] of [
    ["GET", "/pool"], ["GET", "/pedidos"], ["POST", "/pedidos"],
    ["POST", "/pedidos/1/reservar"], ["POST", "/pedidos/1/cancelar"],
  ]) {
    expectError(await http.call(method!, path!), 401, "NAO_AUTORIZADO");
  }
  expectError(await http.call("GET", "/pool", "invalid"), 401, "NAO_AUTORIZADO");
  const expired = harness.app.jwt.sign({ sub: "1" }, { expiresIn: -1 });
  expectError(await http.call("GET", "/pool", expired), 401, "NAO_AUTORIZADO");
  for (const invalid of [{ showId: 8 }, { showId: "7" }, { showId: 7, userId: 999 }, {}]) {
    expectError(await http.call("POST", "/pedidos", token, invalid), 400, "DADOS_INVALIDOS");
  }
  const created = await http.call("POST", "/pedidos", token, { showId: 7 });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: 1, status: "NO_CARRINHO" });
  assert.deepEqual((await http.call("GET", "/pool", token)).body, { total: 100, ocupadas: 0, livres: 100 });
  const stored = await harness.pool.query("SELECT password_hash FROM users WHERE username = 'joao'");
  assert.ok(stored.rows[0].password_hash.startsWith("scrypt:"));
  assert.ok(!stored.rows[0].password_hash.includes("senha123"));
});

test("web assets are served locally with MIME types and security policy", async () => {
  for (const [path, type, content] of [
    ["/", "text/html", "<html lang=\"pt-BR\">"],
    ["/assets/app.css", "text/css", "prefers-reduced-motion"],
    ["/assets/app.js", "text/javascript", "refreshSnapshot"],
  ]) {
    const response = await fetch(new URL(path!, harness.baseUrl));
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith(type!));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(response.headers.get("content-security-policy")?.includes("script-src 'self'"));
    assert.ok((await response.text()).includes(content!));
  }
  assert.equal((await fetch(new URL("/assets/schema.sql", harness.baseUrl))).status, 404);
});

test("listing orders persists states and never includes another user's orders", async () => {
  const [owner, other] = await fixtures(2);
  const [first, second, foreign] = await carts([owner!.id, owner!.id, other!.id]);
  for (const action of ["reservar", "cancelar"]) {
    assert.equal((await harness.http.call("POST", `/pedidos/${first!.id}/${action}`, owner!.token)).status, 200);
  }
  assert.equal((await harness.http.call("POST", `/pedidos/${second!.id}/reservar`, owner!.token)).status, 200);
  const own = await harness.http.call("GET", `/pedidos?userId=${other!.id}`, owner!.token);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, { pedidos: [
    { id: second!.id, status: "RESERVADO" }, { id: first!.id, status: "CANCELADO" },
  ] });
  const otherList = await harness.http.call("GET", "/pedidos", other!.token);
  assert.deepEqual(otherList.body, { pedidos: [{ id: foreign!.id, status: "NO_CARRINHO" }] });
});

test("ownership, legal transitions, idempotency and X-Lote on every reserve success", async () => {
  const [owner, other] = await fixtures(2);
  const { http } = harness;
  const created = await http.call("POST", "/pedidos", owner!.token, { showId: 7 });
  const id = created.body.id as number;
  expectError(await http.call("POST", `/pedidos/${id}/reservar`, other!.token), 404, "NAO_ENCONTRADO");
  expectError(await http.call("POST", `/pedidos/${id}/cancelar`, other!.token), 404, "NAO_ENCONTRADO");
  expectError(await http.call("POST", `/pedidos/${id}/cancelar`, owner!.token), 409, "ESTADO_INVALIDO");
  for (let retry = 0; retry < 2; retry++) {
    const reserved = await http.call("POST", `/pedidos/${id}/reservar`, owner!.token);
    assert.equal(reserved.status, 200);
    assert.deepEqual(reserved.body, { id, status: "RESERVADO" });
    assert.equal(reserved.headers["x-lote"], "7F3A");
    assert.equal(await checkDatabaseInvariants(), 1);
  }
  for (let retry = 0; retry < 2; retry++) {
    const cancelled = await http.call("POST", `/pedidos/${id}/cancelar`, owner!.token);
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { id, status: "CANCELADO" });
    assert.equal(await checkDatabaseInvariants(), 0);
  }
  expectError(await http.call("POST", `/pedidos/${id}/reservar`, owner!.token), 409, "ESTADO_INVALIDO");
  for (const invalid of ["999999", "2147483648", "0", "-1", "1.2", "abc"]) {
    expectError(await http.call("POST", `/pedidos/${invalid}/reservar`, owner!.token), 404, "NAO_ENCONTRADO");
  }
});

test("50 concurrent requests for one user reserve exactly two and cancellation restores quota", async () => {
  const [user] = await fixtures(1);
  const orders = await carts(Array<number>(50).fill(user!.id));
  const results = await Promise.all(orders.map((order) =>
    harness.http.call("POST", `/pedidos/${order.id}/reservar`, user!.token)));
  assert.equal(results.filter((result) => result.status === 200).length, 2);
  for (const result of results.filter((result) => result.status !== 200)) {
    expectError(result, 409, "COTA_PESSOAL");
  }
  assert.equal(await checkDatabaseInvariants(), 2);
  const reservedId = results.find((result) => result.status === 200)!.body.id;
  assert.equal((await harness.http.call("POST", `/pedidos/${reservedId}/cancelar`, user!.token)).status, 200);
  const waitingId = orders[results.findIndex((result) => result.status === 409)]!.id;
  assert.equal((await harness.http.call("POST", `/pedidos/${waitingId}/reservar`, user!.token)).status, 200);
  assert.equal(await checkDatabaseInvariants(), 2);
});

test("100 concurrent retries reserve once and cancel once", async () => {
  const [user] = await fixtures(1);
  const [order] = await carts([user!.id]);
  for (const action of ["reservar", "cancelar"] as const) {
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      harness.http.call("POST", `/pedidos/${order!.id}/${action}`, user!.token)));
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.body.status, action === "reservar" ? "RESERVADO" : "CANCELADO");
      assert.equal(result.headers["x-lote"], action === "reservar" ? "7F3A" : undefined);
    }
    assert.equal(await checkDatabaseInvariants(), action === "reservar" ? 1 : 0);
  }
});

test("1000 simultaneous HTTP reservations: FIFO, 100 winners, consistent snapshots, zero timeouts", async () => {
  const users = await fixtures(1000);
  const orders = await carts(users.map((user) => user.id));
  const tokens = new Map(users.map((user) => [user.id, user.token]));
  // Model users with established connections. This isolates request processing
  // from a simultaneous TCP-handshake burst in the Windows load generator.
  const clients = await warmClients(harness.baseUrl, 1000);
  const events: FifoEvent[] = [];
  const listener = (event: unknown): void => { events.push(event as FifoEvent); };
  fifoEvents.subscribe(listener);
  let finished = false;
  let snapshots = 0;
  let monitorError: unknown;
  const monitor = (async () => {
    while (!finished) {
      const result = await harness.http.call("GET", "/pool", users[0]!.token);
      assert.equal(result.status, 200);
      assert.equal(result.body.total, 100);
      assert.equal(result.body.ocupadas + result.body.livres, 100);
      assert.ok(result.body.ocupadas >= 0 && result.body.ocupadas <= 100);
      snapshots++;
    }
  })().catch((error: unknown) => { monitorError = error; });
  const started = performance.now();
  let results: HttpResult[];
  try {
    const settled = await Promise.allSettled(orders.map((order, index) =>
      clients[index]!.call("POST", `/pedidos/${order.id}/reservar`, tokens.get(order.user_id))));
    const failures = settled.filter((result) => result.status === "rejected");
    assert.equal(failures.length, 0,
      `Every HTTP connection must receive a response; first failure: ${failures[0]?.reason}`);
    results = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  } finally {
    finished = true;
    fifoEvents.unsubscribe(listener);
    await monitor;
    clients.forEach((client) => client.close());
  }
  if (monitorError) throw monitorError;
  const elapsedMs = performance.now() - started;
  const wins = results.filter((result) => result.status === 200);
  assert.equal(wins.length, 100);
  const refusals = results.filter((result) => result.status !== 200);
  assert.equal(refusals.length, 900);
  for (const result of wins) {
    assert.equal(result.body.status, "RESERVADO");
    assert.equal(result.headers["x-lote"], "7F3A");
  }
  for (const result of refusals) expectError(result, 409, "POOL_CHEIO");
  const admitted = events.filter((event) => event.phase === "admitted");
  const startedEvents = events.filter((event) => event.phase === "started");
  const completed = events.filter((event) => event.phase === "finished");
  assert.equal(admitted.length, 1000);
  assert.deepEqual(startedEvents.map((event) => event.sequence), admitted.map((event) => event.sequence));
  assert.deepEqual(completed.map((event) => event.sequence), admitted.map((event) => event.sequence));
  const first100 = new Set(admitted.slice(0, 100).map((event) => Number(event.label.split(":")[1])));
  assert.deepEqual(new Set(wins.map((result) => result.body.id)), first100);
  assert.equal(await checkDatabaseInvariants(), 100);
  const databaseState = await harness.pool.query<{ status: string; count: number }>(
    "SELECT status, count(*)::int AS count FROM orders GROUP BY status",
  );
  assert.equal(databaseState.rows.find((row) => row.status === "NO_CARRINHO")?.count, 900);
  const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction: number): number => Number(latencies[Math.ceil(latencies.length * fraction) - 1]!.toFixed(2));
  const report = {
    generatedAt: new Date().toISOString(), database: databaseVersion,
    transport: "1000 pre-established HTTP/1.1 connections on localhost; simultaneous requests; no HTTP mocks or inject",
    setup: "Users and carts inserted as fixtures; passwords use scrypt; JWTs signed by the app. Authentication endpoints tested separately.",
    concurrentReservations: 1000, successful: 100, poolFull: 900,
    unexpectedResponses: 0, clientTimeouts: 0, clientDeadlineMs: 30000,
    fifoAdmissionOrderVerified: true, databaseInvariantsVerified: true,
    consistentPoolSnapshots: snapshots, durationMs: Number(elapsedMs.toFixed(2)),
    requestsPerSecond: Number((1000 / (elapsedMs / 1000)).toFixed(2)),
    latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99), max: latencies.at(-1) },
    containerExecutionVerified: process.env.TEST_ENVIRONMENT === "docker-compose",
  };
  await mkdir("output", { recursive: true });
  await writeFile("output/load-results.json", JSON.stringify(report, null, 2) + "\n");
  console.log("LOAD_RESULT " + JSON.stringify(report));
});

test("cancellation and reservation racing never release the same seat twice", async () => {
  const users = await fixtures(70);
  const owners = users.slice(0, 50);
  const active = await carts(owners.flatMap((user) => [user.id, user.id]));
  await harness.pool.query("UPDATE orders SET status = 'RESERVADO'");
  const waitingUsers = users.slice(50);
  const waiting = await carts(waitingUsers.map((user) => user.id));
  const tokens = new Map(users.map((user) => [user.id, user.token]));
  const cancellations = active.slice(0, 10).flatMap((order) =>
    Array.from({ length: 5 }, () => harness.http.call("POST", `/pedidos/${order.id}/cancelar`, tokens.get(order.user_id))));
  const reservations = waiting.map((order) =>
    harness.http.call("POST", `/pedidos/${order.id}/reservar`, tokens.get(order.user_id)));
  const cancelResults = await Promise.all(cancellations);
  const reserveResults = await Promise.all(reservations);
  assert.ok(cancelResults.every((result) => result.status === 200));
  const winners = reserveResults.filter((result) => result.status === 200).length;
  assert.ok(winners <= 10);
  for (const refused of reserveResults.filter((result) => result.status !== 200)) {
    expectError(refused, 409, "POOL_CHEIO");
  }
  assert.equal(await checkDatabaseInvariants(), 90 + winners);
  for (const order of waiting) {
    const result = await harness.http.call("POST", `/pedidos/${order.id}/reservar`, tokens.get(order.user_id));
    assert.ok(result.status === 200 || result.status === 409);
  }
  assert.equal(await checkDatabaseInvariants(), 100);
});

test("database row lock protects limits even with independent mutation queues", async () => {
  const users = await fixtures(220);
  const orders = await carts(users.map((user) => user.id));
  const services = Array.from({ length: 8 }, () => new Orders(harness.pool));
  const results = await Promise.allSettled(orders.map((order, index) =>
    services[index % services.length]!.mutate(order.user_id, order.id, "reservar")));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 100);
  for (const result of results) {
    if (result.status === "rejected") assert.equal(result.reason.errorCode, "POOL_CHEIO");
  }
  assert.equal(await checkDatabaseInvariants(), 100);
});

test("personal quota precedes full pool; reserved retry still succeeds", async () => {
  const users = await fixtures(50);
  const orders = await carts(users.flatMap((user) => [user.id, user.id]));
  await harness.pool.query("UPDATE orders SET status = 'RESERVADO'");
  const owner = users[0]!;
  const [extra] = await carts([owner.id]);
  expectError(await harness.http.call("POST", `/pedidos/${extra!.id}/reservar`, owner.token), 409, "COTA_PESSOAL");
  const reserved = orders.find((order) => order.user_id === owner.id)!;
  const retry = await harness.http.call("POST", `/pedidos/${reserved.id}/reservar`, owner.token);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers["x-lote"], "7F3A");
  assert.equal(await checkDatabaseInvariants(), 100);
});

test("rollback restores state and a brief external lock delays without timeout", async () => {
  const [user] = await fixtures(1);
  const [order] = await carts([user!.id]);
  await assert.rejects(transaction(harness.pool, async (client) => {
    await client.query("UPDATE orders SET status = 'RESERVADO' WHERE id = $1", [order!.id]);
    throw new Error("Simulated failure before commit");
  }), /Simulated failure/);
  assert.equal(await checkDatabaseInvariants(), 0);
  const blocker = await harness.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM shows WHERE id = 7 FOR UPDATE");
  const pending = harness.http.call("POST", `/pedidos/${order!.id}/reservar`, user!.token);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await blocker.query("COMMIT");
  } finally { blocker.release(); }
  assert.equal((await pending).status, 200);
  assert.equal(await checkDatabaseInvariants(), 1);
  assert.equal(harness.app.server.requestTimeout, 0);
  assert.equal((await harness.pool.query("SHOW statement_timeout")).rows[0].statement_timeout, "0");
  assert.equal((await harness.pool.query("SHOW lock_timeout")).rows[0].lock_timeout, "0");
});

test("a code-less pg disconnection returns 503 and the next reservation can proceed", async () => {
  const [user] = await fixtures(1);
  const [order] = await carts([user!.id]);
  // Inject the exact error pg emits when its TCP connection ends unexpectedly.
  const failure = mock.method(harness.pool, "connect", async () => {
    throw new Error("Connection terminated unexpectedly");
  });
  try {
    expectError(await harness.http.call("POST", `/pedidos/${order!.id}/reservar`, user!.token),
      503, "INDISPONIVEL");
  } finally { failure.mock.restore(); }
  const stored = await harness.pool.query("SELECT status FROM orders WHERE id = $1", [order!.id]);
  assert.equal(stored.rows[0].status, "NO_CARRINHO");
  const retry = await harness.http.call("POST", `/pedidos/${order!.id}/reservar`, user!.token);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers["x-lote"], "7F3A");
  assert.equal(await checkDatabaseInvariants(), 1);
});

test("creating a cart does not wait for the reservation lock on the show", async () => {
  const [user] = await fixtures(1);
  const blocker = await harness.pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM shows WHERE id = 7 FOR NO KEY UPDATE");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const created = await Promise.race([
      harness.http.call("POST", "/pedidos", user!.token, { showId: 7 }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Cart creation waited for the show lock")), 2000);
      }),
    ]);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "NO_CARRINHO");
    assert.equal(await checkDatabaseInvariants(), 0);
  } finally {
    clearTimeout(timer);
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});
