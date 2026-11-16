/**
 * 開発サーバーで /api/* を動かすための Vite プラグイン（実装仕様書 F1）。
 *
 * 本番では Vercel Functions が api/*.ts を実行する。ローカルで同じことをするには
 * 通常 Vercel CLI（vercel dev）が必要になるが、ハンドラを Web 標準の
 * Request / Response で書いてあるので、開発サーバー側で薄く変換すれば足りる。
 * これにより npm run dev だけで完結する。
 */

import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (request: Request) => Promise<Response>;

/** Node の IncomingMessage を Web 標準の Request に変換する。 */
async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  return new Request(url, { method, headers, body: Buffer.concat(chunks) });
}

/** Web 標準の Response を Node の ServerResponse に書き出す。 */
async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
    // SSE はチャンクごとに送り出さないと、クライアント側で溜まってしまう
    if (typeof (res as ServerResponse & { flush?: () => void }).flush === "function") {
      (res as ServerResponse & { flush: () => void }).flush();
    }
  }
  res.end();
}

export function devApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: "cortex-dev-api",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      // ハンドラは process.env からキーを読むので、ここで注入しておく
      for (const [key, value] of Object.entries(env)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }

      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (!pathname.startsWith("/api/")) return next();
        // /api/_lib/ 以下はフロントが import する部品（featuredWords.json 等）。API ではないので Vite に任せる
        if (pathname.startsWith("/api/_lib/")) return next();

        const name = pathname.slice("/api/".length).replace(/[^a-zA-Z0-9-]/g, "");
        if (!name) return next();

        try {
          const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as Record<string, Handler | undefined>;
          const method = (req.method ?? "GET").toUpperCase();
          const fn = mod[method] ?? mod.default;
          if (typeof fn !== "function") {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: `ハンドラが見つかりません: /api/${name} (${method})` }));
            return;
          }

          const request = await toWebRequest(req);
          const response = await fn(request);
          await writeWebResponse(response, res);
        } catch (e) {
          server.config.logger.error(`[dev-api] /api/${name} failed`);
          console.error(e);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json; charset=utf-8");
          }
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}
