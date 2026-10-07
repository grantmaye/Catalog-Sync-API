import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ApiError(422, `${field} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

export function normalizeFeed(feed) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw new ApiError(422, 'Expected a feed object');
  const vendor = text(feed.vendor, 'vendor', 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(vendor)) throw new ApiError(422, 'vendor must be a slug');
  if (!Array.isArray(feed.products) || !feed.products.length || feed.products.length > 1000) {
    throw new ApiError(422, 'products must contain 1 to 1000 items');
  }
  const seen = new Set();
  const products = feed.products.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ApiError(422, `Invalid product at index ${index}`);
    const sku = text(item.sku, 'sku', 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(sku)) throw new ApiError(422, `Invalid SKU: ${sku}`);
    if (seen.has(sku)) throw new ApiError(422, `Duplicate SKU in feed: ${sku}`);
    seen.add(sku);
    const name = text(item.name, 'name', 200);
    // Decimal strings avoid binary floating point when converting dollars to cents.
    if (typeof item.price !== 'string' || !/^(0|[1-9]\d{0,6})\.\d{2}$/.test(item.price)) {
      throw new ApiError(422, `price for ${sku} must be a USD decimal string, e.g. "129.99"`);
    }
    const [dollars, cents] = item.price.split('.');
    const price_cents = Number(dollars) * 100 + Number(cents);
    if (!Number.isSafeInteger(item.stock) || item.stock < 0 || item.stock > 10000000) {
      throw new ApiError(422, `stock for ${sku} must be an integer from 0 to 10000000`);
    }
    return { sku, name, price_cents, stock: item.stock };
  });
  products.sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  return { vendor, products };
}

export function openCatalog(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, vendor TEXT NOT NULL, sku TEXT NOT NULL,
      name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      stock INTEGER NOT NULL CHECK(stock >= 0), updated_at TEXT NOT NULL,
      UNIQUE(vendor, sku)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
      fingerprint TEXT NOT NULL, result TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
      import_id TEXT NOT NULL REFERENCES imports(id), before_json TEXT,
      after_json TEXT NOT NULL, changed_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS products_vendor_id ON products(vendor, id);
    CREATE INDEX IF NOT EXISTS changes_product_id ON changes(product_id, id);
  `);

  function ingest(feed, key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(key)) {
      throw new ApiError(400, 'Idempotency-Key must contain 1 to 100 letters, numbers, dots, underscores or hyphens');
    }
    const normalized = normalizeFeed(feed);
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM imports WHERE idempotency_key = ?').get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'Idempotency key already used for a different feed');
        db.exec('COMMIT');
        return { ...JSON.parse(previous.result), replayed: true };
      }
      const result = { id: randomUUID(), vendor: normalized.vendor, inserted: 0, updated: 0, unchanged: 0, imported_at: new Date().toISOString() };
      // The parent row exists before audit rows, inside the same transaction.
      db.prepare('INSERT INTO imports VALUES (?, ?, ?, ?)').run(result.id, key, fingerprint, '{}');
      for (const product of normalized.products) {
        const prior = db.prepare('SELECT * FROM products WHERE vendor = ? AND sku = ?').get(normalized.vendor, product.sku);
        const same = prior && ['name', 'price_cents', 'stock'].every(field => prior[field] === product[field]);
        if (same) { result.unchanged++; continue; }
        db.prepare(`INSERT INTO products(vendor, sku, name, price_cents, stock, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(vendor, sku) DO UPDATE SET name=excluded.name, price_cents=excluded.price_cents,
          stock=excluded.stock, updated_at=excluded.updated_at`).run(
          normalized.vendor, product.sku, product.name, product.price_cents, product.stock, result.imported_at
        );
        const current = db.prepare('SELECT * FROM products WHERE vendor = ? AND sku = ?').get(normalized.vendor, product.sku);
        db.prepare('INSERT INTO changes(product_id, import_id, before_json, after_json, changed_at) VALUES (?, ?, ?, ?, ?)')
          .run(current.id, result.id, prior ? JSON.stringify(prior) : null, JSON.stringify(current), result.imported_at);
        result[prior ? 'updated' : 'inserted']++;
      }
      db.prepare('UPDATE imports SET result = ? WHERE id = ?').run(JSON.stringify(result), result.id);
      db.exec('COMMIT');
      return { ...result, replayed: false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  return {
    ingest,
    list({ after = 0, limit = 20, vendor = null } = {}) {
      const rows = db.prepare(`SELECT * FROM products WHERE id > ? AND (? IS NULL OR vendor = ?)
        ORDER BY id LIMIT ?`).all(after, vendor, vendor, limit + 1);
      const data = rows.slice(0, limit);
      return { data, next_cursor: rows.length > limit ? data.at(-1).id : null };
    },
    history(id) {
      if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) throw new ApiError(404, 'Product not found');
      return db.prepare('SELECT * FROM changes WHERE product_id = ? ORDER BY id').all(id).map(row => ({
        id: row.id, import_id: row.import_id, changed_at: row.changed_at,
        before: row.before_json ? JSON.parse(row.before_json) : null, after: JSON.parse(row.after_json)
      }));
    },
    getImport(id) {
      const row = db.prepare('SELECT result FROM imports WHERE id = ?').get(id);
      if (!row) throw new ApiError(404, 'Import not found');
      return JSON.parse(row.result);
    },
    close() { db.close(); }
  };
}
