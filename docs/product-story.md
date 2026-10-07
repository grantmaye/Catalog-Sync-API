# Why a catalog synchronization API helps

## The problem and supported backstory

Supplier feeds rarely arrive exactly once. A scheduled export repeats yesterday's products, a client retries after a timeout, or one malformed price appears beside valid rows. Treating each request as new can duplicate history, partially update stock, or leave support unable to explain which import changed a price.

Catalog Sync API is an independent personal portfolio implementation. The repository contains synthetic suppliers/products and no employer code. There is no live supplier account, documented customer, production-volume, or revenue claim. The following scenario is hypothetical, intended to make the software's value concrete.

## A hypothetical supplier-import day

Imagine a small equipment reseller receiving a fictional Northstar feed. Before a reliable ingestion boundary, a coordinator might copy desk-phone, headset, and adapter values into a spreadsheet, correct SKU case by hand, and guess whether a timed-out upload succeeded. Retrying might produce confusing duplicate history; a late invalid row might leave earlier updates applied.

In this demo the feed arrives through an authenticated API. The service normalizes identity, requires exact decimal prices, validates the whole batch, and commits catalog rows, receipt, and history together. A same-key retry returns the saved receipt. Changing desk-phone stock from 42 to 37 under a new key creates one change entry, while the two unchanged products remain untouched.

Someone investigating the update can see its before/after state and import identity. This demonstrates a technical guarantee and a clearer explanation of change; it does not claim measured time savings or a real retailer's outcome. Evidence lives in the [sample feed](../examples/northstar.json), [demo](../scripts/demo.js), and [transaction implementation](../src/catalog.js).

## Intended users and value

Integration engineers can learn safe retries and atomic ingestion. Catalog operations teams evaluating a concept can see how receipts reduce uncertainty about imports. Backend reviewers can inspect direct SQL and failure-injection tests without external setup. Developers preparing for interviews can explain entity uniqueness, request identity, transaction ordering, and the limits of synchronous storage with runnable evidence.

The benefit is a dependable boundary between incoming records and a consistent local catalog. It is not a storefront, purchasing system, inventory allocator, or automatic live synchronization agent.

| Concern | Hypothetical ad hoc process | Demonstrated behavior |
| --- | --- | --- |
| SKU case | Reconcile duplicate-looking rows manually | Normalize before product identification |
| Decimal prices | Risk rounding on conversion | Validate strings; store integer cents |
| Invalid row | Notice after earlier writes | Validate the batch before writing |
| Lost response | Guess whether to retry | Reuse a key and recover the receipt |
| Changed request with old key | Reuse unrelated intent | Explicit 409 conflict |
| Stock updates | Overwrite without context | Before/after history tied to an import |
| Missing item | Infer deletion from omission | Retain by upsert contract |

## A 60–90 second narration

“Catalog Sync API is a local supplier-ingestion service. Its job is to keep the catalog correct when an upload fails or gets retried.

The first Northstar feed inserts three products and returns a receipt. SKUs are normalized, and prices become integer cents, so twenty-nine cents stays exactly twenty-nine.

Now the same request is repeated with the same idempotency key. The API returns the original receipt with replayed=true; there is no duplicate history.

I change desk-phone stock from 42 to 37 and use a new key. The receipt reports one updated and two unchanged products. History shows the before and after state tied to that import.

The important part is the transaction. Products, receipt, and history commit together. Tests deliberately fail a product insert and an audit write to prove rollback. Two independent SQLite connections also compete for the same key and produce one import plus one replay.

This is a fictional local demo with one credential. Its value is a clear, testable ingestion contract, not a claim that a production supplier integration already exists.”

## Where the story stops

There is no scheduled polling, external connector, XML parser, multi-user authorization, deletion policy, or deployment configuration. History grows without pagination/retention. SQLite writes and lock waits block the event loop. These are explicit limits of an inspectable project.

A real integration would begin with supplier identity, update/deletion semantics, retry ownership, security, error reporting, and retention. The [technical manual](technical-manual.md) provides labs and exercise solutions for evolving those boundaries while preserving the atomic guarantees demonstrated today.
