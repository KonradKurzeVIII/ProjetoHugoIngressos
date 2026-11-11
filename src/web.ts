import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

/** Serve only the three known assets; no request path reaches the filesystem. */
export async function registerWeb(app: FastifyInstance): Promise<void> {
  const assets = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/assets/app.css", "app.css", "text/css; charset=utf-8"],
    ["/assets/app.js", "app.js", "text/javascript; charset=utf-8"],
  ] as const;
  const loaded = await Promise.all(assets.map(async ([route, file, type]) => ({
    route, type,
    content: await readFile(new URL(`../public/${file}`, import.meta.url)),
  })));
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; "
    + "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
    + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  for (const { route, type, content } of loaded) {
    app.get(route, (_request, reply) => reply
      .type(type)
      .header("Cache-Control", "no-cache")
      .header("Content-Security-Policy", csp)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .send(content));
  }
}
