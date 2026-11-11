import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { httpClient, warmClients } from "./http-client.mjs";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const userCount = Number(process.env.LOAD_USERS ?? 200);
assert.ok(Number.isInteger(userCount) && userCount >= 50 && userCount <= 10000,
  "LOAD_USERS must be an integer between 50 and 10000");
const http = httpClient(baseUrl);
let reservationClients = [];

try {
  const prefix = `load-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  console.log(`Preparando ${userCount} usuários; medição exclui cadastro e login.`);
  /** @type {{id: number, token: string}[]} */
  const orders = [];
  let nextUser = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (nextUser < userCount) {
      const index = nextUser++;
      const credentials = { username: `${prefix}-${index}`, password };
      assert.equal((await http.call("POST", "/auth/registrar", undefined, credentials)).status, 201);
      const login = await http.call("POST", "/auth/login", undefined, credentials);
      assert.equal(login.status, 200);
      const token = login.body.token;
      for (let cart = 0; cart < 2; cart++) {
        const result = await http.call("POST", "/pedidos", token, { showId: 7 });
        assert.equal(result.status, 201);
        orders.push({ id: result.body.id, token });
      }
    }
  }));
  const initial = await http.call("GET", "/pool", orders[0].token);
  assert.deepEqual(initial.body, { total: 100, ocupadas: 0, livres: 100 },
    "Use a clean pool. This script never deletes existing data or reservations.");

  reservationClients = await warmClients(baseUrl, orders.length);
  const started = performance.now();
  const settled = await Promise.allSettled(orders.map(async ({ id, token }, index) => {
    const result = await reservationClients[index].call("POST", `/pedidos/${id}/reservar`, token);
    if (result.status === 200) {
      assert.equal(result.headers["x-lote"], "7F3A");
      assert.deepEqual(result.body, { id, status: "RESERVADO" });
    } else {
      assert.equal(result.status, 409);
      assert.deepEqual(result.body, { error: "POOL_CHEIO" });
    }
    return { ...result, token };
  }));
  const failures = settled.filter((result) => result.status === "rejected");
  assert.equal(failures.length, 0, `First failure: ${failures[0]?.reason}`);
  const results = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  const elapsedMs = performance.now() - started;
  const winners = results.filter((result) => result.status === 200);
  assert.equal(winners.length, 100);
  const final = await http.call("GET", "/pool", orders[0].token);
  assert.deepEqual(final.body, { total: 100, ocupadas: 100, livres: 0 });
  const latencies = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction) => Number(latencies[Math.ceil(latencies.length * fraction) - 1].toFixed(2));
  const report = {
    generatedAt: new Date().toISOString(), baseUrl, concurrentReservations: orders.length,
    setup: "All users registered and logged in over HTTP before measurement; two carts per user.",
    transport: "Pre-established persistent HTTP connections; simultaneous reservation requests.",
    successful: 100, poolFull: orders.length - 100, unexpectedResponses: 0,
    clientTimeouts: 0, clientDeadlineMs: 30000,
    durationMs: Number(elapsedMs.toFixed(2)),
    requestsPerSecond: Number((orders.length / (elapsedMs / 1000)).toFixed(2)),
    latencyMs: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99), max: latencies.at(-1) },
  };
  // Release only the reservations this run owns; never reset the database.
  for (const winner of winners) {
    assert.equal((await http.call("POST", `/pedidos/${winner.body.id}/cancelar`, winner.token)).status, 200);
  }
  assert.deepEqual((await http.call("GET", "/pool", orders[0].token)).body,
    { total: 100, ocupadas: 0, livres: 100 });
  await mkdir("output", { recursive: true });
  await writeFile("output/blackbox-load-results.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  reservationClients.forEach((client) => client.close());
  http.close();
}
