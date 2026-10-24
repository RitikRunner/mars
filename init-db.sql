-- Mars Cosmetics Schema Initialization & Initial Seed Data

-- 1. Inbound Events (raw webhook / polled event store)
CREATE TABLE IF NOT EXISTS inbound_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel VARCHAR(32) NOT NULL,
    dedupe_key VARCHAR(256) NOT NULL,
    external_order_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED', -- 'RECEIVED', 'PROCESSED', 'FAILED'
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_inbound_dedupe UNIQUE (channel, dedupe_key)
);

-- 2. Core Inventory Table
CREATE TABLE IF NOT EXISTS inventory (
    sku VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    on_hand INT NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
    reserved INT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Unified Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel VARCHAR(32) NOT NULL,
    external_order_id VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL, -- 'RECEIVED', 'HELD', 'RESERVED', 'BACKORDERED', 'SHIPPED', 'CANCELLED'
    payment_mode VARCHAR(32) NOT NULL,
    shipping_pincode VARCHAR(10) NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL,
    hold_expires_at TIMESTAMPTZ,
    erp_doc_no VARCHAR(64),
    channel_event_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_channel_order UNIQUE (channel, external_order_id)
);

-- 4. Order Items Table
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_no INT NOT NULL,
    sku VARCHAR(64) NOT NULL REFERENCES inventory(sku),
    qty INT NOT NULL CHECK (qty > 0),
    unit_price NUMERIC(10, 2) NOT NULL,
    line_status VARCHAR(32) NOT NULL DEFAULT 'RESERVED', -- 'RESERVED', 'SHORT', 'RELEASED', 'SHIPPED'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_order_line UNIQUE (order_id, line_no)
);

-- 5. Append-Only Stock Audit Ledger
CREATE TABLE IF NOT EXISTS stock_ledger (
    id BIGSERIAL PRIMARY KEY,
    sku VARCHAR(64) NOT NULL REFERENCES inventory(sku),
    delta_on_hand INT NOT NULL DEFAULT 0,
    delta_reserved INT NOT NULL DEFAULT 0,
    on_hand_after INT NOT NULL,
    reserved_after INT NOT NULL,
    available_after INT NOT NULL,
    reason VARCHAR(64) NOT NULL, -- 'RESERVE', 'CANCEL_RELEASE', 'RETURN_RESTOCK', 'DAMAGE_WRITEOFF'
    ref_type VARCHAR(64) NOT NULL, -- 'ORDER_LINE', 'ERP_ADJUSTMENT'
    ref_id VARCHAR(128) NOT NULL,
    channel VARCHAR(32),
    actor VARCHAR(64) DEFAULT 'SYSTEM',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_stock_ledger_ref UNIQUE (ref_type, ref_id, sku, reason)
);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_sku ON stock_ledger(sku, created_at DESC);

-- 6. Channel Stock Listing & Sync State
CREATE TABLE IF NOT EXISTS channel_stock (
    channel VARCHAR(32) NOT NULL,
    sku VARCHAR(64) NOT NULL REFERENCES inventory(sku),
    listing_id VARCHAR(128),
    last_pushed_qty INT NOT NULL DEFAULT 0,
    pushed_version BIGINT NOT NULL DEFAULT 0,
    buffer INT NOT NULL DEFAULT 0,
    cap INT,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel, sku)
);

-- 7. Channel Push Log (Audit of what was shown to each channel)
CREATE TABLE IF NOT EXISTS channel_push_log (
    id BIGSERIAL PRIMARY KEY,
    channel VARCHAR(32) NOT NULL,
    sku VARCHAR(64) NOT NULL,
    qty INT NOT NULL,
    inventory_version BIGINT NOT NULL,
    http_status INT NOT NULL,
    latency_ms INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_log_channel_sku ON channel_push_log(channel, sku, created_at DESC);

-- 8. Persistent Sync Jobs (Transactional Outbox Queue for ERP & Workers)
CREATE TABLE IF NOT EXISTS sync_jobs (
    id BIGSERIAL PRIMARY KEY,
    type VARCHAR(64) NOT NULL, -- 'ERP_CREATE', 'STOCK_PUSH', 'RECONCILE'
    aggregate_key VARCHAR(128) NOT NULL, -- e.g. 'order:<orderId>' or 'channel:NYKAA'
    idempotency_key VARCHAR(256) NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY', 'DEAD', 'DISCARDED'
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_claim ON sync_jobs(status, next_attempt_at) 
WHERE status IN ('PENDING', 'RETRY');

-- 9. Seed 10 Mars Cosmetics Hero SKUs & Channel Listings
INSERT INTO inventory (sku, name, on_hand, reserved, version) VALUES
('MRS-LIP-104', 'Mars Matte Velvet Lipstick - Red Sunset', 100, 0, 1),
('MRS-KJL-011', 'Mars Smudge-proof 24h Eyeliner Kajal', 250, 0, 1),
('MRS-FND-202', 'Mars Natural Glow Liquid Foundation', 80, 0, 1),
('MRS-BLS-305', 'Mars Peachy Rose Powder Blush', 120, 0, 1),
('MRS-MSK-019', 'Mars Hyper-Curl Waterproof Mascara', 150, 0, 1),
('MRS-HLT-401', 'Mars Strobe Illuminating Cream Highlighter', 90, 0, 1),
('MRS-FIX-502', 'Mars Matte Long-Lasting Makeup Setting Spray', 110, 0, 1),
('MRS-PRM-101', 'Mars Pore-Cure Hydrating Primer', 70, 0, 1),
('MRS-EYE-601', 'Mars 16-Color Ultra Pigmented Eyeshadow Palette', 60, 0, 1),
('MRS-LIP-105', 'Mars Lip Gloss Butter Glaze', 140, 0, 1)
ON CONFLICT (sku) DO NOTHING;

-- Seed Channel Stock configs for all 4 channels
INSERT INTO channel_stock (channel, sku, listing_id, last_pushed_qty, pushed_version, buffer, cap)
SELECT c.channel, i.sku, c.channel || '-' || i.sku, i.on_hand, 1, 
       CASE WHEN c.channel = 'FLIPKART' THEN 2 ELSE 0 END, -- 2 buffer on Flipkart
       NULL
FROM inventory i
CROSS JOIN (VALUES ('WEBSITE'), ('NYKAA'), ('FLIPKART'), ('BLINKIT')) AS c(channel)
ON CONFLICT (channel, sku) DO NOTHING;
