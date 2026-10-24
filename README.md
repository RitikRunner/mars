# Mars Cosmetics — Order & Inventory Sync Service

Engineering assessment submission and reference implementation for the **Order & Inventory Sync Service**.

---

## Deliverables Index

* **Primary System Design Document:** [`DESIGN.md`](DESIGN.md) (or [`design/DESIGN.md`](design/DESIGN.md))
* **Architecture Diagram (High-Res PNG):** [`architecture.png`](architecture.png) (or [`design/architecture.png`](design/architecture.png))
* **Mermaid Architecture Source:** [`architecture.mmd`](architecture.mmd) (or [`design/architecture.mmd`](design/architecture.mmd))
* **Candidate Defense & Interview Strategy Guide (Private):** [`CALL_PREP.md`](CALL_PREP.md)

---

## Key Architectural Principles

1. **PostgreSQL as Single Source of Truth (SSOT):**  
   Orders, stock reservations, immutable audit ledger entries, and outbound ERP jobs commit in **one single atomic ACID transaction**. Redis is strictly used for disposable state (token-bucket rate limiting and circuit breakers).
2. **Velocity-Based Publish Policy:**  
   Because marketplace orders are already completed transactions when received, overselling is solved before checkout: channels with high latency or polling blind spots (such as Flipkart’s 2-minute polling) stop showing inventory earlier as stock runs low, leaving the fastest channels and Mars's own website to safely sell the final units.
3. **State-Based Stock Pushes:**  
   Channels are updated with the latest absolute quantity coalesced by SKU (zero-stock first, low-stock second). Rapid updates collapse into single requests, comfortably satisfying Nykaa's 5 req/s limit.
4. **Resilient ERP Delivery:**  
   The Transactional Outbox pattern guarantees effectively-once order delivery to Microsoft Business Central, seamlessly absorbing Sunday maintenance windows (1–2 hours) without dropped orders.
5. **Pragmatic AWS Hosting:**  
   A modular monolith on AWS ECS Fargate, RDS Multi-AZ, and ElastiCache Redis, running within ~₹36,000/month (well under the ₹50,000 budget cap).

---

## Getting Started (Runnable Implementation)

The repository includes a complete, production-grade **NestJS + TypeScript** implementation validating all concurrency guarantees, publish policies, outbox draining, and ops screens.

### 1. Prerequisites
* Node.js v20+
* Docker & Docker Compose (optional, for local PostgreSQL & Redis)

### 2. Environment Setup
```bash
cp .env.example .env
npm install
```

### 3. Spin up Local Database & Redis
```bash
docker-compose up -d
```
*(Automatically creates tables and seeds the 10 Mars Cosmetics hero SKUs and channel listings from `init-db.sql`)*

### 4. Run the Automated Test Suite
```bash
npm test
```
Runs the unit and concurrency invariant test suites:
* **`publish-policy.spec.ts`**: Validates blind window formula, velocity scaling, and Flipkart/Blinkit threshold cutoffs.
* **`reservation.service.spec.ts`**: Proves atomic conditional updates, zero-oversell guarantees, marketplace SHORT line handling, and out-of-order tombstone reconciliation.

### 5. Start the Service
```bash
npm run start:dev
```
Application launches on `http://localhost:3000`.

---

## API Surface

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/webhooks/website` | `POST` | Ingests orders and cancellations from Mars's own website. |
| `/webhooks/nykaa` | `POST` | Ingests Nykaa orders with duplicate and out-of-order resilience (< 50ms ack). |
| `/webhooks/blinkit` | `POST` | Ingests Blinkit quick-commerce orders. |
| `/webhooks/checkout/reserve`| `POST` | Synchronous website reservation API called before customer payment capture. |
| `/ops/failed-syncs` | `GET` | **Ops Screen:** Lists all failed/dead sync jobs and unmapped inbound events. |
| `/ops/retry/:jobId` | `POST` | **Ops Screen:** One-click manual retry for any failed sync job. |
| `/ops/sku-timeline/:sku` | `GET` | **Audit Trail:** Returns complete immutable ledger and push history for any SKU. |
| `/mock/erp/salesOrders` | `POST` | Mock Microsoft Business Central endpoint for testing. |
| `/mock/erp/toggle-maintenance` | `POST` | Toggles simulated Sunday maintenance downtime to verify outbox buffering. |

---

## Project Structure

```
├── src/
│   ├── common/            # Enums, DTOs, and velocity-based Publish Policy math
│   ├── database/
│   │   └── entities/      # TypeORM schema (Inventory, Orders, Ledger, Outbox, etc.)
│   ├── ingestion/         # Webhook controllers and Flipkart 2-min poller
│   ├── reservation/       # Core atomic concurrency engine (conditional updates)
│   │   └── reservation.service.ts
│   ├── stock-push/        # Rate-governed push workers (Nykaa 4 rps, Flipkart 8 rps)
│   ├── erp/               # Transactional Outbox worker with SKIP LOCKED
│   ├── ops/               # Ops UI endpoints (failed sync list, retry, SKU timeline)
│   ├── mock/              # Mock ERP & maintenance toggles
│   ├── app.module.ts
│   └── main.ts
├── init-db.sql            # PostgreSQL DDL and seed data
├── docker-compose.yml     # Local PostgreSQL 16 & Redis 7
├── DESIGN.md              # System design document (<= 4 pages)
├── architecture.png       # Exported architecture diagram
├── architecture.mmd       # Mermaid diagram source file
├── CALL_PREP.md           # Internal interview prep (do not submit)
└── design/
    ├── DESIGN.md          # Mirror copy for /design folder submission
    ├── architecture.png   # Mirror copy of diagram
    └── architecture.mmd   # Mirror copy of Mermaid source
```
