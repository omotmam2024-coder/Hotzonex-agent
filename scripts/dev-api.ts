/**
 * Minimal local runner for the Vercel functions in api/, so the dashboard
 * and webhooks can be developed without `vercel dev`. Passes the exact
 * request bytes through, like Vercel does. Not used in production.
 *   npm run dev:api   (Vite proxies /api to this server)
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLocalEnv } from './load-env.js';

loadLocalEnv();

const PORT = Number(process.env.API_PORT ?? 3001);
const API_DIR = resolve('api');
const ROUTE = /^\/api\/([a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*)\/?$/;

type Handler = (request: Request) => Response | Promise<Response>;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const match = ROUTE.exec(url.pathname);
    const file = match ? resolve(API_DIR, `${match[1]}.ts`) : undefined;
    if (!file || !file.startsWith(API_DIR) || !existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"code":"not_found"}}');
      return;
    }

    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const handler = mod[req.method ?? 'GET'];
    if (typeof handler !== 'function') {
      res.writeHead(405, { 'Content-Type': 'application/json' }).end('{"error":{"code":"method_not_allowed"}}');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else if (value !== undefined) headers.set(key, value);
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await (handler as Handler)(request);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('[dev-api] unhandled error', error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":{"code":"internal_error"}}');
  }
});

server.listen(PORT, () => console.log(`[dev-api] listening on http://localhost:${PORT}`));
