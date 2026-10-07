import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalog } from '../src/catalog.js';
import { createApp } from '../src/app.js';

const feed = () => ({ vendor: 'northstar', products: [
  { sku: 'p1', name: 'Desk Phone', price: '129.99', stock: 4 },
  { sku: 'p2', name: 'Headset', price: '0.29', stock: 2 }
] });

test('normalizes SKUs, stores exact cents, replays equivalent reordered imports', t => {
  const c = openCatalog(); t.after(() => c.close());
  const first = c.ingest(feed(), 'one');
  assert.equal(first.inserted, 2);
  assert.equal(c.list().data[1].price_cents, 29);
  const reordered = feed(); reordered.products.reverse();
  const again = c.ingest(reordered, 'one');
  assert.equal(again.id, first.id);
  assert.equal(again.replayed, true);
  assert.equal(c.history(c.list().data[0].id).length, 1);
});

test('updates changed rows only and preserves before/after history', t => {
  const c = openCatalog(); t.after(() => c.close());
  c.ingest(feed(), 'one');
  const next = feed(); next.products[0].stock = 7;
  const result = c.ingest(next, 'two');
  assert.equal(result.updated, 1); assert.equal(result.unchanged, 1);
  const history = c.history(c.list().data[0].id);
  assert.equal(history[1].before.stock, 4);
  assert.equal(history[1].after.stock, 7);
  assert.equal(c.getImport(result.id).updated, 1);
});

test('conflicting keys and invalid batches never partially update data', t => {
  const c = openCatalog(); t.after(() => c.close());
  c.ingest(feed(), 'one');
  const next = feed(); next.products[0].stock = 9;
  assert.throws(() => c.ingest(next, 'one'), { status: 409 });
  next.products[1].price = 'NaN';
  assert.throws(() => c.ingest(next, 'two'), { status: 422 });
  assert.equal(c.list().data[0].stock, 4);
  next.products[1].price = '12.30';
  assert.equal(c.ingest(next, 'two').updated, 2);
});

test('rejects duplicate SKUs, negative stock, float money and empty batches', t => {
  const c = openCatalog(); t.after(() => c.close());
  for (const mutate of [
    f => { f.products[1].sku = ' P1 '; },
    f => { f.products[0].stock = -1; },
    f => { f.products[0].price = 1.29; },
    f => { f.products = []; }
  ]) { const f = feed(); mutate(f); assert.throws(() => c.ingest(f, 'bad'), { status: 422 }); }
  assert.equal(c.list().data.length, 0);
});

test('persists imports and audit history across process-like reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-test-'));
  let c;
  try {
    const filename = join(dir, 'catalog.sqlite');
    c = openCatalog(filename); c.ingest(feed(), 'one'); c.close(); c = null;
    c = openCatalog(filename);
    assert.equal(c.ingest(feed(), 'one').replayed, true);
    assert.equal(c.history(c.list().data[0].id).length, 1);
  } finally { c?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rolls back product, import and audit writes after a database failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-rollback-'));
  let c; let raw;
  try {
    const filename = join(dir, 'catalog.sqlite');
    c = openCatalog(filename);
    raw = new DatabaseSync(filename);
    raw.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON products WHEN NEW.sku = 'P2'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    assert.throws(() => c.ingest(feed(), 'retry-me'), /simulated failure/);
    assert.equal(c.list().data.length, 0);
    assert.equal(raw.prepare('SELECT count(*) n FROM imports').get().n, 0);
    assert.equal(raw.prepare('SELECT count(*) n FROM changes').get().n, 0);
    raw.exec('DROP TRIGGER fail_second');
    assert.equal(c.ingest(feed(), 'retry-me').inserted, 2);
  } finally { raw?.close(); c?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP API enforces auth, errors, size limits, cursor pages and import replay', async t => {
  const catalog = openCatalog();
  const token = 'test-token-long-enough-for-local-tests';
  const app = createApp({ catalog, token });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); catalog.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'http-one' };
  const post = body => fetch(base + '/v1/imports', { method: 'POST', headers, body });
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/v1/products')).status, 401);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(' '.repeat(1048577))).status, 413);
  assert.equal((await fetch(base + '/v1/imports', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 415);
  assert.equal((await post(JSON.stringify(feed()))).status, 201);
  assert.equal((await post(JSON.stringify(feed()))).status, 200);
  const page1 = await (await fetch(base + '/v1/products?limit=1', { headers })).json();
  const page2 = await (await fetch(base + `/v1/products?limit=1&after=${page1.next_cursor}`, { headers })).json();
  assert.notEqual(page1.data[0].id, page2.data[0].id);
  assert.equal(page2.next_cursor, null);
  assert.equal((await fetch(base + '/v1/products?limit=0', { headers })).status, 400);
  assert.equal((await fetch(base + '/v1/products?after=-1', { headers })).status, 400);
  assert.equal((await fetch(base + '/v1/products/999/history', { headers })).status, 404);
});

test('a failed logging sink cannot break a committed import or its retry', async t => {
  const catalog = openCatalog();
  const token = 'test-token-long-enough-for-local-tests';
  const app = createApp({ catalog, token, logger() { throw new Error('Logging unavailable'); } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); catalog.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const options = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'logging-failure' }, body: JSON.stringify(feed()) };
  const first = await fetch(base + '/v1/imports', options);
  assert.equal(first.status, 201);
  const receipt = await first.json();
  const retry = await fetch(base + '/v1/imports', options);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).id, receipt.id);
  assert.equal(catalog.history(catalog.list().data[0].id).length, 1);
});

test('failed audit write restores existing product values and leaves the key reusable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-update-rollback-'));
  let catalog; let raw;
  try {
    const filename = join(dir, 'catalog.sqlite');
    catalog = openCatalog(filename);
    catalog.ingest(feed(), 'original');
    const before = catalog.list();
    raw = new DatabaseSync(filename);
    raw.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON changes
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const changed = feed(); changed.products[0].stock = 9;
    assert.throws(() => catalog.ingest(changed, 'retry-update'), /audit unavailable/);
    assert.deepEqual(catalog.list(), before);
    assert.equal(raw.prepare('SELECT count(*) n FROM imports').get().n, 1);
    assert.equal(raw.prepare('SELECT count(*) n FROM changes').get().n, 2);
    raw.exec('DROP TRIGGER fail_audit');
    assert.equal(catalog.ingest(changed, 'retry-update').updated, 1);
  } finally { raw?.close(); catalog?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent SQLite connections serialize competing imports with the same key', { timeout: 15000 }, async t => {
  const { Worker } = await import('node:worker_threads');
  const dir = mkdtempSync(join(tmpdir(), 'catalog-contention-'));
  const filename = join(dir, 'catalog.sqlite');
  const initial = openCatalog(filename); initial.close();
  const workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); rmSync(dir, { recursive: true, force: true }); });
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { openCatalog } = await import(workerData.module);
        const catalog = openCatalog(workerData.filename);
        parentPort.once('message', () => {
          let result;
          try { result = catalog.ingest(workerData.feed, 'same-key'); }
          finally { catalog.close(); }
          parentPort.postMessage(result);
        });
        parentPort.postMessage('ready');
      })();
    `, { eval: true, workerData: { module: new URL('../src/catalog.js', import.meta.url).href, filename, feed: feed() } });
    workers.push(worker);
    await once(worker, 'message');
  }
  const replies = workers.map(worker => once(worker, 'message'));
  workers.forEach(worker => worker.postMessage('go'));
  const results = (await Promise.all(replies)).map(([result]) => result);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.equal(results[0].id, results[1].id);
  const catalog = openCatalog(filename);
  try {
    assert.equal(catalog.list().data.length, 2);
    assert.ok(catalog.list().data.every(product => catalog.history(product.id).length === 1));
  } finally { catalog.close(); }
});
