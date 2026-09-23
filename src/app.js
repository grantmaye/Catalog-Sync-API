import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError } from './catalog.js';

export function readBody(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let exceeded = false;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!exceeded) { exceeded = true; chunks.length = 0; reject(new ApiError(413, 'Body exceeds 1 MiB')); }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new ApiError(400, 'Request aborted')));
  });
}

function integer(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new ApiError(400, 'Invalid pagination value');
  }
  return Number(value);
}

export function createApp({ catalog, token, logger = () => {} }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('API_TOKEN must be at least 24 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const start = performance.now();
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(data));
      logger({ request_id: requestId, method: req.method, status, duration_ms: Math.round(performance.now() - start) });
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok' });
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        req.resume();
        throw new ApiError(401, 'Valid bearer token required');
      }
      if (req.method === 'POST' && url.pathname === '/v1/imports') {
        if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
          req.resume(); throw new ApiError(415, 'Content-Type must be application/json');
        }
        const body = await readBody(req);
        let feed;
        try { feed = JSON.parse(body.toString('utf8')); } catch { throw new ApiError(400, 'Malformed JSON'); }
        const result = catalog.ingest(feed, req.headers['idempotency-key']);
        return send(result.replayed ? 200 : 201, result);
      }
      if (req.method === 'GET' && url.pathname === '/v1/products') {
        const after = integer(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
        const limit = integer(url.searchParams.get('limit'), 20, 100);
        if (limit < 1) throw new ApiError(400, 'limit must be between 1 and 100');
        return send(200, catalog.list({ after, limit, vendor: url.searchParams.get('vendor') }));
      }
      const history = url.pathname.match(/^\/v1\/products\/(\d+)\/history$/);
      if (req.method === 'GET' && history) return send(200, { data: catalog.history(integer(history[1], 0, Number.MAX_SAFE_INTEGER)) });
      const imported = url.pathname.match(/^\/v1\/imports\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && imported) return send(200, catalog.getImport(imported[1]));
      req.resume();
      throw new ApiError(404, 'Route not found');
    } catch (error) {
      send(error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Internal server error', request_id: requestId });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
