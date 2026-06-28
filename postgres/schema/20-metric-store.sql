/**
#
# Copyright (c) 2026 majiklTrust Market Intelligence, LLC. All rights reserved.
#
# This file is part of Market Intelligence and contains proprietary and
# confidential information. Unauthorized copying, modification, distribution,
# or use of this file, via any medium, is strictly prohibited without the
# express written permission of the copyright holder.
#

**/

-- ═══════════════════════════════════════════════════════════════
-- 20-metric-store.sql — verified-metrics store (METRICS FIDELITY)
-- ═══════════════════════════════════════════════════════════════
-- Phase 1 feature #3. Stores verified metrics with provenance so
-- content generation can produce posts whose every number traces
-- to a cited source. Two tenant-scoped tables that reuse the
-- existing topics table as the top level:
--
--   metric_groups  — a named grouping of metrics (each Phase-1
--                    "area" is one group). Optionally linked to a
--                    single content topic (0 or 1) via a nullable
--                    composite FK; deleting a topic preserves the
--                    group and nulls the link.
--   metric_values  — an individual verified metric. Belongs to
--                    exactly one group (mandatory; ON DELETE
--                    RESTRICT, so a group with metrics cannot be
--                    deleted out from under them). Carries the exact
--                    NUMERIC value plus its provenance, and a stable
--                    metric_key used for {{METRIC_<key>}} tokenization.
--
-- Both tables carry an `enabled` (active) bit; the read interface
-- serves only active rows, so deactivated metrics never reach a post.
-- "A group has 1+ metrics" is intentionally NOT enforced here (an
-- application-level invariant, by decision).
--
-- Depends on: tenants (01), topics (02). Apply after those.
-- This workstream is consumption-only; no input/ingestion path is
-- defined here — rows are populated out of band.
-- ═══════════════════════════════════════════════════════════════

-- ── metric_groups ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metric_groups (
  id          BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   UUID         NOT NULL,
  topic_id    BIGINT,                       -- nullable: 0 or 1 topic
  slug        VARCHAR(96)  NOT NULL,        -- stable identifier
  label       VARCHAR(256) NOT NULL,
  enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_metric_groups_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Composite FK so a group can never link to a topic in a different
  -- tenant. ON DELETE SET NULL: deleting a content topic preserves
  -- the (valuable) metric group and simply clears its topic link.
  CONSTRAINT fk_metric_groups_topic
    FOREIGN KEY (tenant_id, topic_id) REFERENCES topics(tenant_id, id)
    ON DELETE SET NULL (topic_id),
  CONSTRAINT uq_metric_groups_tenant_slug UNIQUE (tenant_id, slug),
  CONSTRAINT uq_metric_groups_tenant_id   UNIQUE (tenant_id, id)  -- FK target for metric_values
);

CREATE INDEX IF NOT EXISTS idx_metric_groups_tenant_topic
  ON metric_groups(tenant_id, topic_id) WHERE enabled = TRUE;

-- ── metric_values ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metric_values (
  id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID         NOT NULL,
  group_id       BIGINT       NOT NULL,      -- mandatory: belongs to one group
  metric_key     VARCHAR(96)  NOT NULL,      -- stable token id for {{METRIC_<key>}}
  value          NUMERIC      NOT NULL,      -- exact verified number (NUMERIC, not float)
  unit           VARCHAR(64),
  source_quote   TEXT         NOT NULL,      -- cited passage (provenance)
  source_name    VARCHAR(256) NOT NULL,      -- study/author
  source_locator VARCHAR(256),               -- page/table/section
  source_url     TEXT,
  enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
  captured_at    TIMESTAMPTZ,                -- when extracted/verified
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT fk_metric_values_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Composite FK (cross-tenant-safe). ON DELETE RESTRICT: clearing a
  -- group's metrics must be deliberate; the group cannot be deleted
  -- while it still owns metrics.
  CONSTRAINT fk_metric_values_group
    FOREIGN KEY (tenant_id, group_id) REFERENCES metric_groups(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_metric_values_tenant_key UNIQUE (tenant_id, metric_key),
  -- Provenance is mandatory: a value with no source is not a verified
  -- metric. Enforced at the storage layer, not just in code.
  CONSTRAINT ck_metric_values_quote_nonempty CHECK (length(btrim(source_quote)) > 0),
  CONSTRAINT ck_metric_values_name_nonempty  CHECK (length(btrim(source_name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_metric_values_tenant_group
  ON metric_values(tenant_id, group_id) WHERE enabled = TRUE;

-- ── Row-level security (FORCE, deny-by-default) ─────────────────
-- Mirrors 03-rls.sql: same policy name on every table, scoped to
-- current_tenant_id(). FORCE applies RLS even to the table owner.
ALTER TABLE metric_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON metric_groups;
CREATE POLICY tenant_isolation ON metric_groups
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE metric_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_values FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON metric_values;
CREATE POLICY tenant_isolation ON metric_values
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
