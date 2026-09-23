import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { openCatalog } from '../src/catalog.js';
import { createApp } from '../src/app.js';

const catalog = openCatalog();
const token = randomBytes(24).toString('hex');
const app = createApp({ catalog, token });
app.listen(0, '127.0.0.1');
await once(app, 'listening');
const base = `http://127.0.0.1:${app.address().port}`;
const feed = JSON.parse(readFileSync(new URL('../examples/northstar.json', import.meta.url)));
async function request(path, body, key) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  console.log(`${response.status} ${path}`, JSON.stringify(data, null, 2));
  return data;
}
try {
  const first = await request('/v1/imports', feed, 'demo-original');
  assert.equal(first.inserted, 3);
  assert.equal((await request('/v1/imports', feed, 'demo-original')).replayed, true);
  feed.products[0].stock = 37;
  assert.equal((await request('/v1/imports', feed, 'demo-updated')).updated, 1);
  await request('/v1/products?limit=2');
  const all = await request('/v1/products');
  await request(`/v1/products/${all.data.find(p => p.sku === 'DESK-100').id}/history`);
  console.log('Demo passed: import, replay, update, pagination and audit history.');
} finally {
  await new Promise(resolve => app.close(resolve));
  catalog.close();
}
