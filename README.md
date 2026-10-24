# Mars Cosmetics — Order & Inventory Sync Service

Engineering assessment submission for the **Order & Inventory Sync Service**.

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

## Project Structure

```
├── DESIGN.md              # System design document (<= 4 pages)
├── architecture.png       # Exported architecture diagram
├── architecture.mmd       # Mermaid diagram source file
├── CALL_PREP.md           # Internal interview prep (do not submit)
├── README.md              # Repository overview
└── design/
    ├── DESIGN.md          # Mirror copy for /design folder submission
    ├── architecture.png   # Mirror copy of diagram
    └── architecture.mmd   # Mirror copy of Mermaid source
```
