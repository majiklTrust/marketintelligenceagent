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
-- 18-prompt-vault.sql
-- ═══════════════════════════════════════════════════════════════
-- Encrypted storage for AI prompt templates. Platform-level
-- (not tenant-scoped) — prompts are shared across all tenants.
--
-- Prompts are encrypted at rest using AES-256-GCM with a key
-- derived from ENCRYPTION_SECRET via HKDF (same infrastructure
-- as credentials). Decryption happens in-memory at runtime only.
--
-- No RLS — this is a platform table. Access restricted via
-- GRANT to the app role (SELECT + INSERT + UPDATE only).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS prompt_vault (
  key                 VARCHAR(64)  PRIMARY KEY,
  value_enc           BYTEA        NOT NULL,
  encryption_version  SMALLINT     NOT NULL DEFAULT 1
                        CHECK (encryption_version > 0),
  description         TEXT,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Auto-update timestamp
DROP TRIGGER IF EXISTS trg_prompt_vault_updated_at ON prompt_vault;
CREATE TRIGGER trg_prompt_vault_updated_at
  BEFORE UPDATE ON prompt_vault
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- App role can read and write prompts, never drop or alter
GRANT SELECT, INSERT, UPDATE ON prompt_vault TO linkedin_agent_app;

COMMENT ON TABLE prompt_vault IS
  'Encrypted AI prompt templates. Decrypted in-memory at runtime only. Never exposed to clients.';

-- Verify
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'prompt_vault'
  ) THEN
    RAISE NOTICE '  ✓ prompt_vault table created';
  ELSE
    RAISE WARNING '  ✗ prompt_vault table MISSING';
  END IF;
END $$;
