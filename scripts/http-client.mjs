import { Agent, request } from "node:http";

/**
 * @typedef {object} HttpResult
 * @property {number} status
 * @property {any} body
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {number} elapsedMs
 */

/** @param {string} baseUrl */
export function httpClient(baseUrl) {
  const agent = new Agent({ keepAlive: true, maxSockets: 2000 });
  return {
    close: () => agent.destroy(),
    /**
     * @param {string} method
     * @param {string} path
     * @param {string} [token]
     * @param {unknown} [body]
     * @returns {Promise<HttpResult>}
     */
    call(method, path, token, body) {
      const started = performance.now();
      return new Promise((resolveResult, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        /** @type {Record<string, string | number>} */
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (payload !== undefined) {
          headers["content-type"] = "application/json";
          headers["content-length"] = Buffer.byteLength(payload);
        }
        // Total client deadline includes connection setup and queueing in the agent.
        const req = request(new URL(path, baseUrl), {
          method, headers, agent, signal: AbortSignal.timeout(30_000),
        }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { text += chunk; });
          res.on("error", reject);
          res.on("end", () => {
            try {
              resolveResult({
                status: res.statusCode ?? 0,
                body: text ? JSON.parse(text) : undefined,
                headers: res.headers, elapsedMs: performance.now() - started,
              });
            } catch (error) { reject(error); }
          });
        });
        req.on("error", reject);
        req.end(payload);
      });
    },
  };
}

/**
 * Establish persistent HTTP connections gradually, then release requests at once.
 * @param {string} baseUrl
 * @param {number} count
 */
export async function warmClients(baseUrl, count) {
  const clients = Array.from({ length: count }, () => httpClient(baseUrl));
  try {
    for (let offset = 0; offset < clients.length; offset += 32) {
      const results = await Promise.all(clients.slice(offset, offset + 32)
        .map((client) => client.call("GET", "/health")));
      if (results.some((result) => result.status !== 200)) {
        throw new Error("API is not healthy during connection warmup");
      }
    }
    return clients;
  } catch (error) {
    clients.forEach((client) => client.close());
    throw error;
  }
}
