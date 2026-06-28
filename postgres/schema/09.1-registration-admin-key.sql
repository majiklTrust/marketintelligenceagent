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
-- 09.1-registration-admin-key.sql — Admin-provided API key support
-- ═══════════════════════════════════════════════════════════════
-- Adds encrypted API key storage to tenant_registrations so the
-- platform admin can optionally provide an Anthropic key during
-- invite creation. The key is encrypted at rest using
-- ENCRYPTION_SECRET + registration.id as salt.
--
-- On completion: key is transferred to tenant credentials and
-- NULLed from this table.
-- On expiry: key is NULLed by expireStaleRegistrations().
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE tenant_registrations
  ADD COLUMN IF NOT EXISTS api_key_enc BYTEA,
  ADD COLUMN IF NOT EXISTS model_id TEXT;

COMMENT ON COLUMN tenant_registrations.api_key_enc IS
  'AES-256-GCM encrypted Anthropic API key provided by platform admin. NULLed after transfer to tenant credentials or on expiry.';
COMMENT ON COLUMN tenant_registrations.model_id IS
  'Anthropic model ID selected by platform admin (e.g., claude-sonnet-4-20250514). Not a secret — stored as plaintext.';
