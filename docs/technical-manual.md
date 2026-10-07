# Catalog Sync API: technical manual

This repository turns unreliable supplier submissions into durable catalog updates. Read the [product story](product-story.md) for the hypothetical business setting. This manual covers the actual contracts, transactions, failure modes, and extension points. There is no browser application or live supplier integration to configure.

## 1. First principles

A **vendor** is the supplier namespace; a **SKU** identifies a product inside it. Together `(vendor, sku)` define product identity. An **upsert** inserts a missing product or updates an existing one. An **idempotency key** identifies a request intent so a client can retry without applying its effects twice. The key differs from product identity: one request can update many products.

A **fingerprint** is a SHA-256 digest of the normalized feed. It distinguishes a legitimate retry from a key reused for different work. A **receipt** records import ID, vendor, insert/update/unchanged counts, and timestamp. An **audit entry** records before/after product state. A **transaction** makes products, receipt, and history durable together or rolls them all back.

The central promise: if an import commits but its HTTP response is lost, retrying the same normalized feed with the same key returns the saved receipt without adding product changes. This is retry-safe ingestion, not a guarantee about external supplier or downstream business actions.

## 2. Run the real workflow

Use Node.js 24.x. Only built-in HTTP, crypto, SQLite, filesystem, and test modules are used. No dependency installation, build, account, or API key is needed for the self-contained demo.

```bash
node --version
npm test
npm run demo
```

[scripts/demo.js](../scripts/demo.js) generates a temporary API token, opens an OS-assigned loopback port with `listen(0)`, and uses an in-memory database. It imports the [Northstar fixture](../examples/northstar.json), replays it, changes desk-phone stock from 42 to 37 with a new key, lists products, and retrieves history. Expect 201/inserted=3; 200/replayed=true; then 201/updated=1/unchanged=2. Cleanup closes the server and database even when an assertion fails.

For a persistent local server, choose a free port:

```bash
export API_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export PORT=43129
export DB_PATH=./data/manual-catalog.sqlite
npm start
```

Send requests in another terminal with the same environment. Never commit or paste the token into an issue. Stop with Ctrl+C. Restart using the same DB_PATH to inspect durable state. The token minimum is 24 characters; the random example exceeds it. `.env` is ignored by Git but is not automatically read by npm start.

```bash
curl -s "http://127.0.0.1:$PORT/v1/imports" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: manual-first' \
  --data-binary @examples/northstar.json
curl -s "http://127.0.0.1:$PORT/v1/products?limit=2" \
  -H "Authorization: Bearer $API_TOKEN"
```

Defaults are PORT=3000 and DB_PATH=./data/catalog.sqlite. API_TOKEN is required. The executable validates ports from 1 through 65535 and binds only to 127.0.0.1.

## 3. Trace a request through source

| Source | Responsibility |
| --- | --- |
| [src/server.js](../src/server.js) | Validate configuration, create directory, bind loopback, close on signals |
| [src/app.js](../src/app.js) | Routing, bearer check, byte limit, pagination, errors, request IDs/logging |
| [src/catalog.js](../src/catalog.js) | Normalization, fingerprint, schema, transaction, reads |
| [scripts/demo.js](../scripts/demo.js) | Real HTTP walkthrough with assertions |
| [test/catalog.test.js](../test/catalog.test.js) | Domain/HTTP tests, durable replay, injected failures, independent connections |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | Node 24 tests and executable demo |

POST /v1/imports passes bearer authentication, media-type validation, a 1 MiB body reader, and JSON parsing. `catalog.ingest` validates the key and every product **before** opening a transaction. It hashes normalized data, begins an immediate transaction, checks the prior key, then replays or applies changes. The response carries x-request-id; errors include the same ID, and logs include it with method, status, and duration.

The optional logger is a synchronous callback. If it throws, the HTTP result remains valid: a logging failure cannot undo a committed import, send another response after headers, or create an unhandled request rejection. The server prints a generic stderr notice. An async sink must handle its own promise failures; it is outside this synchronous callback contract.

## 4. Feed normalization and exact money

[normalizeFeed](../src/catalog.js) accepts an object containing vendor and products:

| Field | Contract |
| --- | --- |
| vendor | Trim/lowercase; 1–64 characters; letter/digit followed by letters/digits/hyphens |
| sku | Trim/uppercase; 1–64 characters; letter/digit followed by letters/digits/dot/underscore/hyphen |
| name | Trimmed nonempty string, maximum 200 characters |
| price | USD string from `0.00` to `9999999.99`, exactly two decimals, no extra whitespace/leading zeroes |
| stock | Safe integer from 0 to 10,000,000 |

A batch contains 1–1,000 products. Duplicate **normalized** SKUs reject the entire batch. Extra properties are ignored. Products sort by normalized SKU before hashing, so input order does not matter. Vendor/SKU case and whitespace around vendor/SKU/name do not change the fingerprint. Product-name case remains meaningful. Prices are neither trimmed nor accepted as numeric JSON values.

For `"0.29"`, splitting at the decimal point yields `0 * 100 + 29` cents. This avoids binary floating-point dollars-to-cents conversion. Maximum accepted cents remain inside JavaScript's exact integer range. There is no currency conversion: amounts mean USD.

Absent products are retained: this is an upsert batch, not an authoritative snapshot/delete request. A new key with unchanged products creates a new receipt, but no product history or timestamp changes.

## 5. Schema, transactions, and invariants

[openCatalog](../src/catalog.js) creates STRICT SQLite tables:

| Table | Keys and fields | Purpose |
| --- | --- | --- |
| products | Integer ID; unique vendor/SKU; name, cents, stock, updated_at | Current catalog |
| imports | UUID ID; globally unique key; fingerprint; JSON result | Durable retry receipt |
| changes | Integer ID; product/import foreign keys; before/after JSON; timestamp | Actual change history |

Foreign keys are enabled, and product cents/stock have nonnegative SQL checks. String rules and upper bounds live in validation. The vendor/ID index supports listings; the product/history-ID index supports history. CREATE IF NOT EXISTS initializes this schema but is not a versioned migration framework.

WAL means **write-ahead log**: readers can coexist with a writer in many cases, but SQLite still has one writer at a time. A five-second busy timeout is configured before journal/schema work so initialization can wait for another connection. `BEGIN IMMEDIATE` establishes write intent before reading a key. That prevents two writers both treating the same missing key as their own. Lock timeouts remain possible; the API returns a generic 500 and a client should retry the same intent/key. Synchronous SQLite queries and lock waits block Node's event loop.

A fresh import creates a placeholder receipt first to satisfy audit foreign keys. For each sorted product it reads prior state, compares name/cents/stock, upserts changed values, reads the new row, and records history. It then fills in the receipt and commits. Any exception inside the transaction rolls back the whole unit.

Maintain these invariants:

1. One product per vendor/SKU, one receipt per global key.
2. Same key/feed replays the original ID, timestamp, and counts.
3. Changed feed under the same key conflicts without writes.
4. Products, receipt, and history commit together.
5. Unchanged products create no audit entries; missing products are retained.
6. Failed imports leave their keys reusable.

The contention test uses worker threads with separate SQLite connections to one temporary file. Both start the same key after a readiness barrier. Exactly one import is new, one is replayed, both share a receipt ID, and each product has one history entry. This exercises database serialization beyond sequential JavaScript calls.

## 6. HTTP contracts and trust boundary

| Request | Behavior |
| --- | --- |
| GET /health | 200 process liveness, no auth |
| POST /v1/imports | 201 new / 200 replay; Idempotency-Key required |
| GET /v1/imports/:uuid | Saved receipt, without a synthetic replay flag |
| GET /v1/products | data and next_cursor; defaults limit=20, after=0 |
| GET /v1/products/:id/history | data array, ordered by history insertion ID |

All except health require the single bearer token, compared using timingSafeEqual after a length check. There is no user, role, or vendor authorization. Every credential holder can access all vendors. Parameterized SQL protects query values; it does not establish tenant isolation.

Keys permit 1–100 letters/digits/dots/underscores/hyphens and are global across vendors. Pagination limit is 1–100; after is a nonnegative safe integer. next_cursor is the last returned ID only when another page exists. Keep the same vendor filter across pages and use the exact normalized lowercase vendor. Pagination is a live view; history is unbounded.

Errors are `{error, request_id}`: 400 malformed JSON/key/pagination; 401 bad credential; 404 unknown route/resource; 409 conflicting key; 413 over 1 MiB; 415 wrong media type; 422 invalid feed; 500 unexpected failure. API responses are no-store JSON with nosniff. The body reader measures bytes, not character count. Header/request timeouts are 10/15 seconds. Health is liveness, not a database readiness guarantee.

## 7. Failure laboratories

### A. Equivalent retry and conflicting intent

Send the sample with `manual-first` twice: expect 201 then 200 with the same receipt. Reverse products or change vendor/SKU case and retry: still a replay. Change stock while retaining the key: 409, no change. Use a new key for the changed feed: one updated product and a new receipt. The normalization and conflict tests reproduce these paths.

### B. Validation before writes

```bash
node --test --test-name-pattern='invalid batches|rejects duplicate' test/catalog.test.js
```

A valid first change followed by an invalid price must produce no partial update. Normalized duplicate SKUs, negative stock, numeric money, and empty batches reject. Correcting the feed lets the failed key be used successfully.

### C. Mid-import database failure

```bash
node --test --test-name-pattern='database failure' test/catalog.test.js
```

An SQLite trigger rejects the second product. Expect zero products, receipts, and history rows after rollback, even though the first product and parent receipt had been written. Dropping the test trigger and retrying the same key inserts both products.

### D. Audit failure after an existing stock update

```bash
node --test --test-name-pattern='failed audit write' test/catalog.test.js
```

A trigger rejects history insertion after stock changes. Expect the full original catalog (including timestamps), one original receipt, and two original history rows. Dropping the trigger permits the same failed key to update one product. This proves that “stock UPDATE ran” does not mean the audited import committed.

### E. Logging and competing writers

```bash
node --test --test-name-pattern='logging sink|independent SQLite' test/catalog.test.js
```

The logger throws deliberately. Expect normal 201 then 200 replay, a single history entry, and two expected generic stderr notices. The independent-connection case expects one new import and one replay, with no duplicate history.

### F. Persistence and diagnostics

The reopen test saves to a file, closes it, reopens, and replays: receipt and history must survive. If data unexpectedly disappears, inspect DB_PATH and the working directory. On 401, check that both terminals have the same token without printing it. On busy errors, stop competing disposable writers or retry after a pause; never delete a live database/WAL file as a shortcut. Request IDs connect client errors to logs without logging credentials or feed contents.

## 8. Extension exercises with solution directions

[EXERCISES.md](../EXERCISES.md) contains the original prompts.

1. **Single-product endpoint:** add a parameterized lookup returning the list row shape, validate the path ID, return 404 for absence, and test the real HTTP route including auth. No import change is required.
2. **Dry run:** extract change classification and return planned counts without consuming a key. Assert all three tables stay unchanged. A preview remains advisory; the actual import must recheck under its transaction.
3. **Different supplier format:** adapt incoming fields to the existing contract before normalization. Keep parsing separate from persistence; test a malformed row rejects the batch. Never bypass money/stock rules in the adapter.
4. **Queued ingestion:** durably store job intent/key before returning 202, then expose status and recovery. Move blocking work into an appropriate worker/database design. A 202 response alone does not make work durable.
5. **Vendor authorization:** map an authenticated principal to allowed vendors, define scoped keys, and migrate constraints consistently. A feed's vendor string is never proof of access.

## 9. Interview questions and maintenance limits

**How do uniqueness and idempotency differ?** Entity uniqueness identifies a product; request idempotency protects one batch's effects and receipt. Many legitimate requests can update one product.

**What happens after commit and a lost response?** The same-key retry finds the durable receipt and avoids repeating history.

**Why BEGIN IMMEDIATE?** It serializes the read/check/write sequence before another writer can claim the key; two-connection tests demonstrate it.

**Why no automatic deletes?** Missing data might mean a partial feed. Deletion needs an explicit snapshot/tombstone contract.

**Where would scale hurt?** Validation/hashing, synchronous database work, and lock waiting block the event loop. Bounded requests make a local demo inspectable; they are not a performance guarantee.

**What remains for production?** Tenant policy, token rotation, TLS, rate limits, workers if needed, migrations, retention, monitoring, backup/restore, and a real supplier contract. Zero third-party runtime packages is a small dependency surface, not a claim of zero security risk; keep Node patched.

There are no lint/type/build/browser scripts: this is a JavaScript HTTP API without a frontend or installed packages. The relevant exact checks are npm test, npm run demo, source inspection, documentation links, and the CI run for the tested commit. None establishes a customer, production scale, or deployment outcome.
