# Make the project your own

Start by running the demo, then follow one import through `src/app.js` and `src/catalog.js`.

## Small contribution

Add a `GET /v1/products/:id` endpoint. Return `404` for a missing product and include an HTTP test. Keep the JSON representation consistent with the list endpoint.

## More substantial contribution

Add a dry-run mode that reports inserts, updates and unchanged products without writing any products, receipts or history. Test that all three tables stay unchanged. Decide whether a dry run should consume an idempotency key, and document the decision.

## Advanced contribution

Add a supplier adapter for a different field naming convention, then normalize into the existing contract. Keep supplier parsing separate from persistence. Demonstrate a malformed upstream record and explain whether the adapter rejects the batch or returns explicit per-record errors.

## Be ready to explain

1. Why is a unique `(vendor, sku)` constraint different from an idempotency key?
2. What happens if the import commits but the client never receives the response?
3. How does `BEGIN IMMEDIATE` help when two processes import concurrently?
4. Which work blocks the event loop, and where would you introduce a worker or queue?
5. Why doesn't a missing product mean it should be deleted?

Use your own extension, tests, and tradeoffs as the interview story. This repository is a new personal implementation, not evidence of a language used at a prior employer.
