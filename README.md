# Mars Cosmetics — Order & Inventory Sync Service

Engineering assessment submission and prototype implementation for the **Order & Inventory Sync Service**.

---

## Deliverables Index

* **Primary System Design Document:** [`design/DESIGN.md`](design/DESIGN.md)
* **Architecture Diagram (High-Res PNG):** [`design/architecture.png`](design/architecture.png)
* **Mermaid Architecture Source:** [`design/architecture.mmd`](design/architecture.mmd)

---

## Key Architectural Principles

1. **PostgreSQL as Single Source of Truth (SSOT):**  
   Orders, stock reservations, immutable audit ledger entries, and outbound ERP jobs commit in **one single atomic ACID transaction**. Redis is used for disposable state (token-bucket rate limiting and circuit breakers).
2. **Velocity-Based Publish Policy:**  
   Because marketplace orders are already completed transactions when received, overselling is solved before checkout: channels with high latency or polling blind spots (such as Flipkart’s 2-minute polling) stop showing inventory earlier as stock runs low, leaving the fastest channels and Mars's own website to safely sell the final units.
3. **State-Based Stock Pushes:**  
   Channels are updated with the latest absolute quantity coalesced by SKU (zero-stock first, low-stock second). Rapid updates collapse into single requests, comfortably satisfying Nykaa's 5 req/s limit.
4. **Resilient ERP Delivery:**  
   The Transactional Outbox pattern guarantees effectively-once order delivery to Microsoft Business Central, seamlessly absorbing Sunday maintenance windows (1–2 hours) without dropped orders.
5. **Pragmatic AWS Hosting:**  
   A modular monolith on AWS ECS Fargate, RDS Multi-AZ, and ElastiCache Redis, running within ~₹36,000/month (well under the ₹50,000 budget cap).

---

## Prototype Overview (`src/`)

The code in `src/` is a simplified prototype of the reservation, ingestion, outbox and push logic; channel and ERP calls are simulated against mock endpoints; token buckets are in-memory (Redis in the design).

### 1. Prerequisites
* Node.js v20+
* Docker & Docker Compose (for local PostgreSQL 16 and Redis)

### 2. Environment Setup & Installation
```bash
cp .env.example .env
docker-compose up -d
npm ci
```
*(The database container automatically initializes tables and seeds the 10 Mars Cosmetics hero SKUs and channel listings from `init-db.sql`)*

### 3. Running Tests
```bash
# Run unit tests (publish policy math & reservation logic)
npm test

# Run concurrency integration tests against real PostgreSQL
npm run test:concurrency
```

### 4. Running the Service
```bash
# Build the project
npm run build

# Start in development mode
npm run start:dev
```
Application launches on `http://localhost:3000`.

---

## cURL Verification Examples

### 1. Ingest Sample Nykaa Order
```bash
curl -X POST http://localhost:3000/webhooks/nykaa \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "NYKAA",
    "external_order_id": "NYK-20261023-884213",
    "event": "ORDER_CREATED",
    "event_time": "2026-10-23T11:04:52+05:30",
    "items": [
      { "sku": "MRS-LIP-104", "qty": 2, "unit_price": 349.00 },
      { "sku": "MRS-KJL-011", "qty": 1, "unit_price": 199.00 }
    ],
    "payment_mode": "PREPAID",
    "shipping_pincode": "110034",
    "total_amount": 897.00
  }'
```
*Response:* `{"received":true,"external_order_id":"NYK-20261023-884213"}`.  
The raw event is written to `inbound_events`; within ~1s `EventProcessorService` reserves stock atomically and creates the ERP outbox job.

### 2. Duplicate Order Replay (Idempotent)
Send the exact same request again:
```bash
curl -X POST http://localhost:3000/webhooks/nykaa \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "NYKAA",
    "external_order_id": "NYK-20261023-884213",
    "event": "ORDER_CREATED",
    "event_time": "2026-10-23T11:04:52+05:30",
    "items": [
      { "sku": "MRS-LIP-104", "qty": 2, "unit_price": 349.00 },
      { "sku": "MRS-KJL-011", "qty": 1, "unit_price": 199.00 }
    ],
    "payment_mode": "PREPAID",
    "shipping_pincode": "110034",
    "total_amount": 897.00
  }'
```
*Response:* HTTP 200 `{"received":true,...}`. Raw event hits `UNIQUE(channel, dedupe_key) ON CONFLICT DO NOTHING`; no duplicate inventory deduction occurs.

### 3. Toggle ERP Sunday Maintenance
```bash
# Toggle maintenance offline (simulates Sunday downtime returning HTTP 503)
curl -X POST http://localhost:3000/mock/erp/toggle-maintenance

# Check maintenance status
curl http://localhost:3000/mock/erp/status
```
Orders submitted while offline will have their ERP jobs safely back off in `RETRY` status in `sync_jobs`. Toggle maintenance back online (`POST /mock/erp/toggle-maintenance`), and the outbox worker will drain the backlog and set `orders.erp_doc_no`.

---

## Known Gaps (Prototype Limitations)

* **HMAC Verification:** Webhook endpoints accept incoming payloads without cryptographic HMAC header verification.
* **Authentication on Ops Endpoints:** `/ops/*` endpoints are unauthenticated in the prototype (ALB OIDC in the production design).
* **Blinkit CSV:** The daily CSV generation and upload is not implemented; urgent stock pushes are simulated.
* **Reconciliation Polls:** The 15-minute order list reconciliation jobs across marketplaces are omitted.
* **Business Central Stock Puller:** Stock movement synchronization from BC item ledger entries is simulated.
* **Simulated Channel Calls:** Nykaa, Flipkart, and Blinkit push endpoints log requests rather than executing real marketplace API calls.

---

## Project Structure

```
├── src/
│   ├── common/            # Enums, DTOs, and velocity-based Publish Policy math
│   ├── database/
│   │   └── entities/      # TypeORM schema (Inventory, Orders, Ledger, Outbox, etc.)
│   ├── ingestion/         # Webhooks, EventProcessorService, Flipkart poller
│   ├── reservation/       # Core atomic concurrency engine (conditional updates)
│   ├── stock-push/        # Rate-governed push workers (Nykaa 4 rps, Flipkart 8 rps, Blinkit 4 rps)
│   ├── erp/               # Transactional Outbox worker with SKIP LOCKED and circuit breaker
│   ├── ops/               # Ops endpoints (failed syncs, retry, replay, SKU timeline)
│   ├── mock/              # Mock ERP endpoints & maintenance toggle
│   ├── app.module.ts
│   └── main.ts
├── init-db.sql            # PostgreSQL DDL and initial seed data
├── docker-compose.yml     # Local PostgreSQL 16 & Redis
└── design/
    ├── DESIGN.md          # System design document (<= 4 pages)
    ├── architecture.png   # Exported architecture diagram
    └── architecture.mmd   # Mermaid diagram source
```
