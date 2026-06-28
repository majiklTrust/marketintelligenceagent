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
-- 19-prompt-genre.sql
-- ═══════════════════════════════════════════════════════════════
-- Adds genre support to the prompt_vault table so a single prompt
-- key (e.g. 'content_generator') can have multiple genre-specific
-- templates. The pre-existing template becomes the 'default' genre.
--
-- DESIGN
--   • Row identity changes from (key) to (key, genre).
--   • The existing single row is migrated to genre='default' via
--     the column DEFAULT — no data is deleted or re-encrypted.
--   • Encryption is UNCHANGED: genre rows use the identical
--     AES-256-GCM + HKDF scheme (see prompt-vault.js). Genre is a
--     row discriminator, never a cryptographic input.
--   • genre is a constrained identifier (CHECK), not free text —
--     defense in depth alongside the API-layer regex.
--
-- IDEMPOTENT
--   Safe to run multiple times. Guards on column existence and
--   constraint/PK names so re-running is a no-op.
--
-- NO NEW GRANT
--   DDL 18 already granted SELECT/INSERT/UPDATE on prompt_vault to
--   linkedin_agent_app. Adding a column does not change that. The
--   genre insert path is gated at the application layer
--   (requirePlatformAdmin), not by a separate DB role.
-- ═══════════════════════════════════════════════════════════════

-- ── Step 1: add the genre column ─────────────────────────────
-- NOT NULL with DEFAULT 'default' means the existing row is
-- transparently assigned genre='default' with no UPDATE needed.
ALTER TABLE prompt_vault
  ADD COLUMN IF NOT EXISTS genre VARCHAR(32) NOT NULL DEFAULT 'default';

-- ── Step 2: constrain genre to a safe identifier ─────────────
-- Reserved value 'default' is always allowed. Any other value
-- must match ^[a-z][a-z0-9_]{1,31}$ (lowercase, starts with a
-- letter, 2-32 chars). Mirrors the API-layer validation regex.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prompt_vault_genre_chk'
  ) THEN
    ALTER TABLE prompt_vault
      ADD CONSTRAINT prompt_vault_genre_chk
      CHECK (genre = 'default' OR genre ~ '^[a-z][a-z0-9_]{1,31}$');
    RAISE NOTICE '  ✓ genre CHECK constraint added';
  ELSE
    RAISE NOTICE '  • genre CHECK constraint already present';
  END IF;
END $$;

-- ── Step 3: switch primary key from (key) to (key, genre) ────
-- The original PK was named prompt_vault_pkey (PostgreSQL default
-- for a column-level PRIMARY KEY). Drop it only if it is still the
-- single-column form, then add the composite PK. Guarded so a
-- second run (where the composite PK already exists) does nothing.
DO $$
DECLARE
  pk_columns int;
BEGIN
  -- Count how many columns the current PK spans.
  SELECT count(*)
    INTO pk_columns
    FROM information_schema.key_column_usage
   WHERE constraint_name = 'prompt_vault_pkey'
     AND table_name = 'prompt_vault';

  IF pk_columns = 1 THEN
    -- Still the original single-column PK — migrate to composite.
    ALTER TABLE prompt_vault DROP CONSTRAINT prompt_vault_pkey;
    ALTER TABLE prompt_vault ADD CONSTRAINT prompt_vault_pkey
      PRIMARY KEY (key, genre);
    RAISE NOTICE '  ✓ primary key migrated to (key, genre)';
  ELSIF pk_columns >= 2 THEN
    RAISE NOTICE '  • composite primary key already present';
  ELSE
    RAISE WARNING '  ✗ prompt_vault_pkey not found — manual review needed';
  END IF;
END $$;

-- ── Verify ───────────────────────────────────────────────────
DO $$
DECLARE
  has_genre   boolean;
  default_cnt int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'prompt_vault' AND column_name = 'genre'
  ) INTO has_genre;

  IF has_genre THEN
    RAISE NOTICE '  ✓ prompt_vault.genre column present';
  ELSE
    RAISE WARNING '  ✗ prompt_vault.genre column MISSING';
  END IF;

  -- Confirm the pre-existing content_generator row is now default genre.
  SELECT count(*) INTO default_cnt
    FROM prompt_vault
   WHERE key = 'content_generator' AND genre = 'default';

  IF default_cnt = 1 THEN
    RAISE NOTICE '  ✓ content_generator default-genre row intact';
  ELSE
    RAISE NOTICE '  • content_generator default-genre rows: %', default_cnt;
  END IF;
END $$;

COMMENT ON COLUMN prompt_vault.genre IS
  'Genre discriminator for multi-template prompt keys. ''default'' is the base template. Not a cryptographic input — encryption is identical across genres.';
