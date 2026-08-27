-- 0009_artifacts — the publish transaction: runtime.survey_tokens, publish, rollback, and the
-- one token alphabet that keeps two surveys off one origin (P1-08).
--
-- Deliverable B §3.1 (the version lifecycle and "rollback is archived -> production plus
-- repointing artifact_hash"), §3.2 (runtime token resolution — the denormalized table the
-- runtime reads instead of joining surveys to survey_versions), §2 (the runtime RPC shape:
-- SECURITY DEFINER, search_path = '', a 3s statement_timeout, and NO org_id argument), §12
-- (RLS), §13 (the token -> artifact index), §14 (expand/contract, the timeout header);
-- Deliverable C §17 (the artifact and what is in it); Deliverable H §2.7 (GET
-- /v1/versions/{id}/tokens); Deliverable K §3 (status and compile_state as two axes, and the
-- one-production-per-survey rule), K §5 (THE TOKEN ALPHABET — canonical, overriding B §3.2);
-- ADR-002 (content addressing, the version as the unit of immutability), ADR-005 (the
-- per-survey isolated origin, which is where the token ends up), ADR-009 (org_id on every
-- row; the runtime holds no table privilege); roadmap P1-08 and risk R8.
--
-- WHAT THIS MIGRATION IS FOR. P1-08's DB column reads "runtime.survey_tokens maintained by
-- the publish transaction" — the table that gets a respondent from a public URL to an
-- artifact hash — plus the acceptance criterion "rolling back to the previous version
-- repoints artifact_hash and flips archived -> production in under 5 seconds, and the runtime
-- serves byte-identical bytes to what was live before". Both of those are one transaction
-- each, and this migration is those two transactions, expressed as functions so that "the
-- token row and the version's artifact_hash move together, or neither moves" is a property of
-- the database rather than of whichever caller remembered to open a transaction.
--
-- Migration header first, mandated by Deliverable B §14 and enforced by
-- tools/ci/lint-migrations.mjs (which reads the first 60 lines, so the reasoning below comes
-- after it rather than before): an ALTER TABLE waiting behind a long read drags an
-- ACCESS EXCLUSIVE lock queue with it and stalls the runtime. Failing fast and retrying is
-- strictly better than blocking. Everything here is expand-only — one new table, five new
-- functions, one function body replaced, two CHECK constraints added NOT VALID and then
-- validated — so there is no rename, no in-place type change, and no default that has to be
-- materialized over rows that already exist.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. What this migration deliberately does NOT create
-- ---------------------------------------------------------------------------
-- Three of the four things P1-08's DB column lists already exist. Recorded here because
-- "add the columns the milestone names" would otherwise produce a duplicate set under
-- slightly different names, and because a reader looking for them should be told where they
-- are rather than left to conclude the migration forgot them.
--
--   1. app.survey_versions.artifact_hash (app.sha256), .artifact_bytes (bigint, with its
--      non-negative CHECK), .compile_diagnostics (jsonb NOT NULL DEFAULT '[]') and
--      .acknowledged_warnings (jsonb NOT NULL DEFAULT '[]') were all created by 0004,
--      together with sv_compiled_needs_artifact and sv_live_needs_compiled. NOTHING IS
--      ADDED to that table here except the two array-shape CHECKs in §9 and the column
--      comments 0004 left unwritten, because P1-08 is the milestone that starts writing
--      those two JSONB columns and an unwritten column has no shape yet. No renames, no
--      in-place type changes; the linter rejects both and so would this file's author.
--
--   2. ops.jobs.kind NEEDS NOTHING. 0003 made it `text` with jobs_kind_fmt
--      (`^[a-z][a-z0-9_]{1,63}$`) and said why in the column comment: "free text rather than
--      an enum on purpose: job kinds are an implementation detail of apps/worker and adding
--      one must not require a migration". apps/worker/src/kinds/registry.ts agrees from the
--      other side — `compile` is "one line here plus one file next to noop.ts". So the DB
--      side of the compile job kind is already done, and adding a CHECK or an enum listing
--      `compile` would be inventing a constraint 0003 deliberately refused, in the direction
--      it refused it. The one thing publish DOES rely on is 0003's jobs_idem_key, which is
--      what makes double-clicking Publish produce one job (M0.4 acceptance).
--
--   3. runtime.survey_token, the DOMAIN, was created in 0001 with exactly the pattern this
--      migration needs. See §1: it is reused, not redefined, and this is the first table to
--      use it.
--
-- Not created either, and each is a forward note rather than an omission:
--   * runtime.sessions / response_documents / response_events (P1-09, P1-10). 0001's
--     ops.ensure_event_partitions() already skips the response_events parent until it
--     exists, so it stays callable.
--   * B §3.2's `quota_policy jsonb` on the token row. It carries 03 §8's quota settings
--     including ADR-008's on_store_unavailable, and nothing in P1-08 writes or reads it —
--     a column nothing writes is the table equivalent of a grant with no consumer (0008's
--     phrasing for the on_unknown column it declined to add). It arrives with P1-12's
--     quota work, which is also when the artifact starts carrying the plan it mirrors.
--   * A token REVOCATION function. Revoking is `revoked_at := now()` and the only caller is
--     H §2.7's DELETE, which does not exist yet. The column is here because the partial
--     unique index in §2 is defined against it and because a revoked token must remain in
--     the table (see that index's comment).

-- ---------------------------------------------------------------------------
-- 1. The token alphabet: reused from 0001, and why it must never be widened
-- ---------------------------------------------------------------------------
-- THE POINT OF THIS TABLE IS ITS PRIMARY KEY'S DOMAIN, so the reasoning is restated here
-- even though the CREATE DOMAIN is in 0001 — 0001 created the domain before any table could
-- use it, and this is the table.
--
-- runtime.survey_token is `text` CHECKed against '^[0-9a-z]{26}$' plus '!~ ^[0-9]+$'.
-- LOWERCASE base-36, 26 characters, ~134 bits from a CSPRNG. Deliverable K §5 is canonical
-- here and OVERRIDES B §3.2, which specified '^[0-9A-Za-z]{22}$' — 22 characters of base-62.
-- THIS MIGRATION IS THE SUPERSESSION, recorded explicitly so the next reader does not file
-- the mismatch as a mistake: db/README.md's deviation list already carries it, and
-- packages/schema/src/registries.ts ships the same regex as SURVEY_TOKEN_PATTERN, which is
-- what the API validator and the runtime's hostname assertion read. Three copies of one
-- pattern, deliberately, because the three live in three languages; they are kept honest by
-- this migration's test.sql, which rejects an uppercase token by name.
--
-- WHY LOWERCASE, i.e. what breaks if someone "helpfully" widens it back to base-62 to
-- recover four characters of URL length. ADR-005 serves every survey from its own origin,
-- `https://<token>.run.<domain>`, and that token is therefore a DNS LABEL. DNS labels are
-- case-INSENSITIVE. Under a mixed-case alphabet `aB4…` and `Ab4…` are two distinct rows in
-- this table — distinct primary keys, distinct surveys, distinct tenants — that resolve to
-- ONE origin. The failure is not a 404. It is a respondent following a vendor link into
-- survey A and being served survey B's artifact, with survey B's quotas and survey B's
-- data collection, and it is invisible until an analyst finds the wrong completes in the
-- wrong study. That is roadmap risk R8, named there as "the base62-in-DNS trap", and K §5
-- says of it: "this must be fixed before the first token is issued", because rotating tokens
-- after links are in the field breaks live vendor links irrecoverably.
--
-- Three consequences worth stating because each is a thing somebody will try:
--   * The token column is NOT case-folded on read. runtime.resolve_token (§7) matches
--     byte-for-byte and returns NOTHING for an uppercase spelling. Adding lower() there
--     would reintroduce exactly the collision the alphabet exists to prevent — one origin,
--     two rows, and now the database agreeing to serve both. Deliverable G §3.1 additionally
--     requires the runtime to assert hostname-label == path-token byte-for-byte and 404 on
--     mismatch; this function is the database half of that assertion.
--   * 26 characters is not a style choice. 22 characters of base-36 is ~113 bits, below the
--     128-bit floor B §3.2's base-62 choice was aiming for, and this token is an
--     unauthenticated bearer capability: guessing one is entering a live survey. 26 gives
--     ~134 bits and still fits a 63-octet DNS label with room for the rest of the hostname.
--   * The second CHECK ('!~ ^[0-9]+$') is not decoration: an all-digits label can be read as
--     an IPv4-ish hostname component by resolvers and proxies. runtime.gen_survey_token (§4)
--     redraws rather than raising, so the branch costs nothing and is taken about once every
--     10^14 tokens.

-- ---------------------------------------------------------------------------
-- 2. runtime.survey_tokens (B §3.2, §13)
-- ---------------------------------------------------------------------------
CREATE TABLE runtime.survey_tokens (
  token             runtime.survey_token PRIMARY KEY,
  org_id            app.ulid NOT NULL,
  survey_id         app.ulid NOT NULL,
  survey_version_id app.ulid NOT NULL,
  artifact_hash     app.sha256 NOT NULL,
  status            app.version_status NOT NULL,
  is_test           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  -- ADR-009's composite-FK pattern, the same one every other table here uses: the
  -- denormalized org_id is kept honest by a foreign key into a UNIQUE (org_id, id) rather
  -- than by the writer being careful.
  FOREIGN KEY (org_id, survey_version_id)
    REFERENCES app.survey_versions (org_id, id),
  FOREIGN KEY (org_id, survey_id)
    REFERENCES app.surveys (org_id, id),
  -- No DEFAULT on `token`: app.gen_ulid is a column default on eight primary keys and this
  -- one deliberately is not, for the reason B §3.2 gives about token generation — a token is
  -- minted in exactly one place (runtime.upsert_survey_token, §4) so that "every token in
  -- this table came out of one CSPRNG through one alphabet" is greppable rather than hoped
  -- for. A column default would make an INSERT that forgot the column mint a valid token,
  -- which is the shape of the bug R8 describes.
  --
  -- THERE IS DELIBERATELY NO CHECK TYING is_test TO status. The obvious one —
  -- `is_test = (status <> 'production')` — is false in the ordinary case: a version published
  -- to staging for review and then promoted to production is reachable through BOTH links at
  -- once, and the review link must keep marking its sessions is_test while pointing at a
  -- production version. That is what a soft launch is. is_test is a property of the LINK, not
  -- of the version behind it, which is precisely why B §3.2 stores both columns instead of
  -- deriving one.
  CONSTRAINT tokens_revoked_after_created
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
COMMENT ON TABLE runtime.survey_tokens IS
  'B §3.2. 01 §3.3 step 1 resolves a survey token to an artifact, and that is THE ONE THING '
  'the runtime reads from Postgres — so it gets its own denormalized table in schema runtime '
  'rather than a join across app.surveys and app.survey_versions. The denormalization is the '
  'point: it means the runtime RPC owner needs no read privilege anywhere in `app`, so the '
  'plane boundary (ADR-001) is a GRANT list of one table and one function rather than a '
  'reviewer''s promise. Maintained ONLY by app.publish_version and app.rollback_version '
  '(both SECURITY DEFINER) and read only by runtime.resolve_token; there is no policy and no '
  'grant that lets anything else write it. One live row per (survey, is_test), reused across '
  'republishes — see tokens_live_key.';
COMMENT ON COLUMN runtime.survey_tokens.token IS
  'Deliverable K §5''s 26-character LOWERCASE base-36 token, ~134 bits from a CSPRNG, never '
  'derived from the survey id. The domain (0001) is the enforcement; §1 of this migration is '
  'the argument. It appears in a HOSTNAME (ADR-005: <token>.run.<domain>), DNS labels are '
  'case-insensitive, and a mixed-case alphabet therefore lets two distinct rows here resolve '
  'to one origin — roadmap risk R8, whose failure mode is a respondent being served another '
  'survey''s artifact. Supersedes B §3.2''s ^[0-9A-Za-z]{22}$.';
COMMENT ON COLUMN runtime.survey_tokens.artifact_hash IS
  'NOT NULL, which is a deliberate narrowing of B §3.2 (where it is nullable). ADR-002 makes '
  'the artifact content-addressed, so this column IS the answer to "which bytes does this URL '
  'serve"; a row that cannot answer it is a 500 for a respondent who has already been counted '
  'as an entrant by a panel vendor. The publish sequence is upload -> upsert token -> flip '
  'compile_state (roadmap P1-08), so the hash is always known by the time this row is '
  'written, and requiring it here is what makes that ordering non-optional.';
COMMENT ON COLUMN runtime.survey_tokens.is_test IS
  'P1-11: "populated by the publisher — the runtime never interprets status". A review-link '
  'token marks its sessions, events and documents is_test = true; the live token does not. It '
  'is a SEPARATE column from `status` and NOT derivable from it: test-mode semantics (E '
  '§14.1: quota gate read-only, webhooks suppressed, redirects shown as an interstitial) must '
  'not depend on the runtime knowing what app.version_status means, and the same version is '
  'legitimately reachable through a review link and the live link at the same time during a '
  'soft launch. A property of the link, not of the version.';
COMMENT ON COLUMN runtime.survey_tokens.status IS
  'DENORMALIZED from app.survey_versions.status, so the runtime can render "this survey has '
  'closed" without a second read and without any privilege in `app`. Denormalized means it '
  'can drift, and the mitigation is that it has exactly two writers (§4''s upsert, called by '
  'publish and rollback), each of which resyncs EVERY live token of the survey from its own '
  'version row — so archiving the version behind a review link updates that link''s row in '
  'the same transaction. The runtime must not branch on this for test-mode behaviour; that '
  'is what is_test is for.';
COMMENT ON COLUMN runtime.survey_tokens.revoked_at IS
  'Soft revocation. The row STAYS: a token is a URL that has been printed on a vendor '
  'contract, and "this link is dead" and "this link was never issued" must be '
  'distinguishable six months later — the first is a 410 the support desk can explain, the '
  'second is a mystery. tokens_live_key is partial on this column so a revoked token frees '
  'its (survey, is_test) slot without freeing its own string.';
COMMENT ON CONSTRAINT tokens_revoked_after_created ON runtime.survey_tokens IS
  'A link cannot be revoked before it was issued. Cheap, and it is the constraint that '
  'catches a caller writing revoked_at from a client clock: "this token was dead for two '
  'hours before it existed" is the kind of fact that makes an incident timeline unusable.';

CREATE UNIQUE INDEX tokens_live_key ON runtime.survey_tokens (survey_id, is_test)
  WHERE revoked_at IS NULL;
COMMENT ON INDEX runtime.tokens_live_key IS
  'AT MOST ONE LIVE TOKEN per (survey, is_test) — one production URL and one review URL per '
  'survey — which is what makes republishing REPOINT a token instead of minting one. That is '
  'not an optimization: K §5 says rotating tokens after links are in the field breaks live '
  'vendor links irrecoverably, so a publish that produced a new URL would silently invalidate '
  'every link already in the field. Partial on revoked_at, so retiring a survey and reissuing '
  'it later is expressible while the retired token remains readable (see that column).';

CREATE INDEX survey_tokens_version_idx ON runtime.survey_tokens (survey_version_id);
COMMENT ON INDEX runtime.survey_tokens_version_idx IS
  'B §3.2 verbatim. Serves H §2.7''s GET /v1/versions/{id}/tokens (via '
  'app.survey_tokens_for_version) and the publisher''s own "which URLs point at the version I '
  'am about to archive". Not unique: one version legitimately carries both a production and a '
  'review token, and after a rollback the archived version still carries the review token it '
  'was reviewed through.';

CREATE TRIGGER tokens_touch BEFORE UPDATE ON runtime.survey_tokens
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();
COMMENT ON TRIGGER tokens_touch ON runtime.survey_tokens IS
  'updated_at answers "when did this URL last change what it serves", which during an '
  'incident is the difference between a rollback that took effect and a rollback that '
  'returned success. By trigger, not by whoever remembers.';

-- NOTE ON THE ABSENT DRAFT TRIGGER. This table carries a survey_version_id, so a reader who
-- has just come from 0007 or 0008 will expect content.tg_draft_only on it. It must NOT be
-- here, and not merely because the table is outside schema `content`: that trigger refuses
-- any write whose version is not a draft, and every row in THIS table is written at the exact
-- moment its version stops being a draft. Attaching it would make publishing impossible.
-- ops.content_tables_without_draft_trigger() scans schema content only and therefore agrees.

-- ---------------------------------------------------------------------------
-- 3. Row level security and grants (B §12, ADR-009)
-- ---------------------------------------------------------------------------
-- ENABLE makes policies apply; FORCE makes them apply to the table OWNER too. Note what
-- ops.tables_without_rls() would say about this table: NOTHING — it scans app, content,
-- billing and export, which is B §12's list, and schema runtime is not on it. So the guard
-- that has caught every other table cannot catch this one, which is exactly why both
-- statements are here and why this migration's test.sql asserts relrowsecurity AND
-- relforcerowsecurity from pg_class directly. FORWARD NOTE: when P1-09/P1-10 add
-- runtime.sessions, response_documents and response_events, adding 'runtime' to
-- ops.tables_without_rls()'s schema list is one CREATE OR REPLACE and would put the whole
-- data plane back under the standing guard. It is not done here because the hash-partitioned
-- tables B §8.1 specifies would each need their own decision about partition-level RLS, and
-- making that decision for tables that do not exist yet is how an exemption row gets written.
ALTER TABLE runtime.survey_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime.survey_tokens FORCE  ROW LEVEL SECURITY;

-- OWNERSHIP, and a deliberate deviation from 0001. 0001's ops.ensure_event_partitions()
-- reassigns every runtime.response_events partition to runtime_rpc_owner, because those
-- tables are WRITTEN by the runtime RPCs and "definer" should mean that role rather than
-- "superuser". This table is written by the CONTROL PLANE — app.publish_version and
-- app.rollback_version, definer functions owned by the migration runner, which also have to
-- read app.survey_versions — and read by the runtime. Ownership follows the writer, so it
-- stays with the runner, and the runtime's read is a GRANT plus a policy: one line of ACL and
-- one line of predicate, both visible in the catalog, instead of an ownership that cannot be
-- narrowed. If ownership followed the reader instead, either the publish functions would need
-- privileges on a table they do not own (breaking any deployment whose migration runner is
-- BYPASSRLS-but-not-superuser) or the token writer would need read privileges throughout
-- `app`, which is the grant this whole design exists to avoid.
GRANT SELECT ON runtime.survey_tokens TO runtime_rpc_owner;

CREATE POLICY tokens_rpc_read ON runtime.survey_tokens FOR SELECT TO runtime_rpc_owner
USING (revoked_at IS NULL);
COMMENT ON POLICY tokens_rpc_read ON runtime.survey_tokens IS
  'The ONLY policy on this table, and note what it does not do: it does not compare org_id to '
  'anything. That is not an oversight, it is B §2''s design — no runtime RPC takes an org_id '
  'argument, because the TOKEN IS THE CAPABILITY. 134 bits of CSPRNG in the URL is what '
  'authorizes the read, and there is no caller identity to scope against: the respondent is '
  'anonymous. Scoping the predicate to a "current org" would be theatre, because the only '
  'role that can reach this policy is runtime_rpc_owner, which exists to own one function '
  'that resolves one token. The revoked_at filter is real, though: a revoked token must stop '
  'serving without the row being deleted. Every other command has NO POLICY AT ALL, which is '
  'a deliberate deny — the same asymmetry 0004 used on app.audit_log, where the absence of an '
  'INSERT policy is what makes app.write_audit_event the only writer.';

-- ADR-009's negative capability, restated for the table that just appeared. 0004's
-- catalog-wide assertions cover app and content and say nothing about schema runtime, and
-- 0001's ALTER DEFAULT PRIVILEGES never granted anything here, but "nothing granted it" and
-- "it is revoked" read differently to an auditor and only one of them survives a future
-- GRANT ... ON ALL TABLES IN SCHEMA runtime.
REVOKE ALL ON runtime.survey_tokens FROM authoring, runtime_writer, analytics_reader;
-- runtime_writer — the role the respondent-facing runtime actually connects as — gains
-- NOTHING here. Its capability surface stays exactly what 0004 gave it: EXECUTE on
-- runtime.resolve_token and runtime.load_session. That is roadmap risk R3 ("the runtime's
-- Postgres capability surface grows"), and the whole reason §7 implements the RPC instead of
-- granting SELECT on this table: a leaked edge credential can resolve tokens one at a time,
-- which it can already do with a URL, and cannot enumerate them.

-- ---------------------------------------------------------------------------
-- 4. Minting and repointing a token — the one writer
-- ---------------------------------------------------------------------------
CREATE FUNCTION runtime.gen_survey_token() RETURNS runtime.survey_token
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  k_alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_token text;
  v_bytes bytea;
  v_i     integer;
  v_b     integer;
BEGIN
  LOOP
    v_token := '';
    v_bytes := app.pgcrypto_gen_random_bytes(64);
    v_i     := 0;
    WHILE length(v_token) < 26 LOOP
      IF v_i >= 64 THEN
        v_bytes := app.pgcrypto_gen_random_bytes(64);
        v_i     := 0;
      END IF;
      v_b := get_byte(v_bytes, v_i);
      v_i := v_i + 1;
      -- REJECTION SAMPLING, not modulo. 256 is not a multiple of 36, so `byte % 36` alone
      -- would make the first four letters of the alphabet ~14% more likely than the rest —
      -- a measurable bias in a value whose only job is to be unguessable. 252 = 7 * 36, so
      -- bytes 0..251 map uniformly and the remaining four are redrawn.
      CONTINUE WHEN v_b >= 252;
      v_token := v_token || substr(k_alphabet, (v_b % 36) + 1, 1);
    END LOOP;
    -- The domain's second CHECK rejects an all-digits label (it can be read as an IPv4-ish
    -- hostname component). Redraw rather than raise: this function must not be able to fail
    -- in the middle of a publish, and (10/36)^26 means the branch is taken approximately
    -- never.
    EXIT WHEN v_token !~ '^[0-9]+$';
  END LOOP;
  RETURN v_token::runtime.survey_token;
END $$;
COMMENT ON FUNCTION runtime.gen_survey_token() IS
  'THE ONE PLACE A SURVEY TOKEN IS GENERATED (K §5). Having exactly one implementation is '
  'what makes "every token is 26 lowercase base-36 characters from a CSPRNG, never derived '
  'from the survey id" an auditable claim rather than an aspiration — grep for this function '
  'and you have found every mint path, which is the same argument 0004 makes for '
  'app.hash_invitation_token. pgcrypto''s gen_random_bytes, not random(): random() is a '
  'seeded PRNG whose state a co-tenant query can influence, and this value is a bearer '
  'capability for a live survey. SECURITY DEFINER only so callers need no USAGE on schema '
  'public, where pgcrypto lives (0001 revoked that from PUBLIC); it is granted to no role at '
  'all and is reachable only from the definer function below.';

CREATE FUNCTION runtime.upsert_survey_token(p_version_id app.ulid, p_is_test boolean)
RETURNS runtime.survey_token
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v       app.survey_versions%ROWTYPE;
  v_token runtime.survey_token;
  v_try   integer := 0;
BEGIN
  SELECT * INTO v FROM app.survey_versions sv WHERE sv.id = p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'survey_version % does not exist', p_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v.artifact_hash IS NULL THEN
    RAISE EXCEPTION 'survey_version % has no artifact_hash and cannot be served', p_version_id
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'upload the artifact first: the publish order is upload, token, '
                   'compile_state.';
  END IF;

  -- REPOINT FIRST. A live token for this (survey, is_test) is a URL already in the field, so
  -- the publish path must reuse it; minting is the exception, not the rule (tokens_live_key).
  UPDATE runtime.survey_tokens t
     SET survey_version_id = v.id,
         artifact_hash     = v.artifact_hash,
         status            = v.status
   WHERE t.survey_id = v.survey_id
     AND t.is_test   = p_is_test
     AND t.revoked_at IS NULL
  RETURNING t.token INTO v_token;

  IF v_token IS NULL THEN
    LOOP
      v_try := v_try + 1;
      INSERT INTO runtime.survey_tokens
        (token, org_id, survey_id, survey_version_id, artifact_hash, status, is_test)
      VALUES (runtime.gen_survey_token(), v.org_id, v.survey_id, v.id, v.artifact_hash,
              v.status, p_is_test)
      ON CONFLICT (token) DO NOTHING
      RETURNING token INTO v_token;
      EXIT WHEN v_token IS NOT NULL;
      -- Unreachable at 134 bits, and the loop is here anyway: the alternative is a publish
      -- that fails with a primary-key violation the caller cannot act on. Bounded so a bug
      -- in gen_survey_token surfaces as an error rather than as a spinning transaction
      -- holding a row lock on app.surveys.
      IF v_try >= 5 THEN
        RAISE EXCEPTION 'could not mint a unique survey token after % attempts', v_try
          USING ERRCODE = 'unique_violation';
      END IF;
    END LOOP;
  END IF;

  -- Resync the survey's OTHER live tokens. `status` is denormalized (B §3.2), and the
  -- transaction that just promoted one version demoted another: without this, the review
  -- link of the version that was archived a microsecond ago still reports 'production'. One
  -- statement over at most two rows.
  UPDATE runtime.survey_tokens t
     SET status = sv.status
    FROM app.survey_versions sv
   WHERE t.survey_version_id = sv.id
     AND t.survey_id = v.survey_id
     AND t.revoked_at IS NULL
     AND t.status <> sv.status;

  RETURN v_token;
END $$;
COMMENT ON FUNCTION runtime.upsert_survey_token(app.ulid, boolean) IS
  'THE ONLY WRITER of runtime.survey_tokens, called by app.publish_version and '
  'app.rollback_version and granted to NO ROLE — reachable only from those two definer '
  'functions, which is what makes the table''s complete absence of write policies a real '
  'guarantee rather than a gap. Takes a version id and a boolean and derives org_id, '
  'survey_id, artifact_hash and status FROM THE VERSION ROW rather than accepting them: a '
  'parameter for org_id would be a way to write a token row into another tenant, and B §2''s '
  'rule that no function in schema runtime takes an org_id is asserted from the catalog in '
  '0004''s test.sql. Repoints an existing live token rather than minting a new one, because a '
  'token is a URL that is already in the field (K §5).';

REVOKE EXECUTE ON FUNCTION runtime.gen_survey_token() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION runtime.upsert_survey_token(app.ulid, boolean) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. app.publish_version — the publish transaction (P1-08, K §3)
-- ---------------------------------------------------------------------------
-- THE DECISION THIS FUNCTION IS: publish is a SECURITY DEFINER function, not ordinary DML
-- from the worker's role. Four reasons, and the fourth is the one that settles it.
--
--   1. It spans the plane boundary. The token row lives in schema runtime, whose USAGE
--      `authoring` deliberately does not hold (0001 grants it app, content and billing only,
--      and db/README.md's role table says "may not reach ops or runtime"). Ordinary DML would
--      mean granting the control-plane role USAGE on runtime plus INSERT/UPDATE on this
--      table — a permanent widening of the studio's reachable surface, in the schema whose
--      whole purpose is to be unreachable from it.
--   2. It is the only place a token is minted. If publish were DML, the CSPRNG and the
--      alphabet would live in TypeScript, and R8's mixed-case token generator becomes a
--      thing a future refactor can reintroduce with no SQL review. Here the alphabet is a
--      domain, the mint is one function, and both are asserted.
--   3. Atomicity is the acceptance criterion, not an implementation detail. "A failed publish
--      always leaves the previously live artifact serving" (K §3, Deliverable A §7) means the
--      incumbent's demotion, the new version's artifact columns and the token repoint are one
--      unit. As DML that is four statements a caller must remember to wrap, and the caller is
--      a worker that can be killed between any two of them.
--   4. The floor differs by target, and K §1 says how: `publish` is a project_manager
--      capability (rank 50) while "publish to staging" is a programmer one (rank 40). An RLS
--      policy on app.survey_versions cannot express that, because the policy sees an UPDATE
--      and not an intent — 0004's sv_update is deliberately silent about status transitions
--      for exactly this reason, leaving them to app.tg_version_guard. A function has the
--      intent in its argument list.
--
-- WHAT IS *NOT* A FUNCTION, so that this is not read as "publish-adjacent writes go through
-- RPCs": the FAILURE path. Recording compile_state = 'failed' with diagnostics is an ordinary
-- UPDATE that 0004's sv_update policy already permits at the programmer floor, and it needs
-- no new object because K §3 requires it to change nothing else — a failed compile must not
-- touch status, and 0004's sv_compiled_needs_artifact means it cannot claim a hash either. A
-- definer function there would add a privileged write path for an operation whose entire
-- specification is "write two columns and nothing else".
--
-- CALLING CONVENTION, worth stating because it is the one thing a reader will get wrong: the
-- compile worker must assume the enqueuing user's identity (set request.jwt.claims from
-- ops.jobs.org_id / created_by, SET LOCAL ROLE authoring) before calling this. The capability
-- check below is then the same one the studio would have made, and the audit row names a
-- human. A worker calling it with no claims gets insufficient_privilege, which is correct:
-- "the system published this" is not an answer anyone accepts six months later.
CREATE FUNCTION app.publish_version(
  p_version_id            app.ulid,
  p_artifact_hash         app.sha256,
  p_artifact_bytes        bigint DEFAULT NULL,
  p_target_status         app.version_status DEFAULT 'production',
  p_compile_diagnostics   jsonb DEFAULT NULL,
  p_acknowledged_warnings jsonb DEFAULT NULL,
  p_request_id            text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v          app.survey_versions%ROWTYPE;
  v_floor    app.org_role;
  v_demoted  app.ulid;
  v_is_test  boolean;
  v_token    runtime.survey_token;
BEGIN
  IF p_target_status NOT IN ('staging', 'production') THEN
    RAISE EXCEPTION 'publish target must be staging or production, not %', p_target_status
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'draft and review are authoring states; archived is reached by '
                   'app.rollback_version or by retiring a survey.';
  END IF;
  IF p_artifact_hash IS NULL THEN
    RAISE EXCEPTION 'publish requires an artifact hash (ADR-002: artifacts are '
                    'content-addressed)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v FROM app.survey_versions sv WHERE sv.id = p_version_id FOR UPDATE;

  -- K §1: publish is project_manager; publish to staging is programmer.
  v_floor := CASE WHEN p_target_status = 'production'
                  THEN 'project_manager'::app.org_role
                  ELSE 'programmer'::app.org_role END;
  -- ONE message for "no such version" and "not yours" and "not permitted", because
  -- distinguishing them is an existence oracle across tenants — the same reason P1-01's
  -- acceptance criterion insists a forged active_org_id yields zero rows rather than an
  -- error.
  IF NOT FOUND
     OR v.org_id <> app.current_org()
     OR NOT app.has_role(v_floor)
     OR NOT app.can_see_survey(v.survey_id) THEN
    RAISE EXCEPTION 'survey version % is not publishable by this caller', p_version_id
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'publishing to production requires project_manager; to staging, '
                   'programmer (Deliverable K §1).';
  END IF;

  -- Serialize publishes per SURVEY. The invariant being protected is per-survey (at most one
  -- production version, app.sv_one_production), so the lock has to be too: without it two
  -- concurrent publishes both see no incumbent to demote, both promote, and one of them
  -- fails on the partial unique index with a 23505 that says nothing about what happened.
  -- Locking the survey row makes the second one wait and then find the incumbent it has to
  -- archive.
  PERFORM 1 FROM app.surveys s WHERE s.id = v.survey_id FOR UPDATE;

  IF p_target_status = 'production' THEN
    UPDATE app.survey_versions sv SET status = 'archived'
     WHERE sv.survey_id = v.survey_id AND sv.status = 'production' AND sv.id <> v.id
    RETURNING sv.id INTO v_demoted;
  END IF;

  -- ONE statement for the artifact columns and the status, so sv_live_needs_compiled
  -- ("a version may only enter staging or production with compile_state = 'compiled'") is
  -- satisfied by the row rather than by statement ordering. COALESCE on the two JSONB
  -- columns means NULL is "leave it alone": acknowledged_warnings in particular is SEALED by
  -- app.tg_version_guard once the version is frozen, so a republish must be able to say
  -- nothing about it rather than being forced to restate it. The first publish is the one
  -- UPDATE that both freezes the version and records 03 §17's acknowledgement, which is
  -- precisely when the sign-off happens.
  UPDATE app.survey_versions sv
     SET artifact_hash         = p_artifact_hash,
         artifact_bytes        = COALESCE(p_artifact_bytes, sv.artifact_bytes),
         compile_state         = 'compiled',
         compile_diagnostics   = COALESCE(p_compile_diagnostics, sv.compile_diagnostics),
         acknowledged_warnings = COALESCE(p_acknowledged_warnings, sv.acknowledged_warnings),
         status                = p_target_status
   WHERE sv.id = v.id;

  v_is_test := (p_target_status <> 'production');
  v_token   := runtime.upsert_survey_token(v.id, v_is_test);

  PERFORM app.write_audit_event(
    p_org_id            => v.org_id,
    p_action            => 'version.published',
    p_actor_kind        => CASE WHEN app.current_user_id() IS NULL THEN 'system'
                                ELSE 'user' END,
    p_target_kind       => 'survey_version',
    p_target_id         => v.id,
    p_survey_id         => v.survey_id,
    p_survey_version_id => v.id,
    p_summary           => format('published version %s to %s', v.version_no,
                                  p_target_status),
    p_diff              => jsonb_build_object(
                             'status', jsonb_build_object('from', v.status,
                                                          'to', p_target_status),
                             'artifact_hash', jsonb_build_object('from', v.artifact_hash,
                                                                 'to', p_artifact_hash),
                             'token', v_token,
                             'is_test', v_is_test,
                             'demoted_version_id', v_demoted,
                             'acknowledged_warnings', p_acknowledged_warnings),
    p_request_id        => p_request_id);

  RETURN jsonb_build_object(
    'token', v_token,
    'survey_id', v.survey_id,
    'survey_version_id', v.id,
    'artifact_hash', p_artifact_hash,
    'status', p_target_status,
    'is_test', v_is_test,
    'demoted_version_id', v_demoted,
    'previous_artifact_hash', v.artifact_hash);
END $$;
COMMENT ON FUNCTION app.publish_version(app.ulid, app.sha256, bigint, app.version_status,
  jsonb, jsonb, text) IS
  'THE PUBLISH TRANSACTION (roadmap P1-08). Records the artifact on the version, flips '
  'compile_state to ''compiled'', moves status to staging or production, archives the '
  'incumbent production version, and repoints or mints the survey''s token — all in one '
  'statement, so K §3''s "a failed publish always leaves the previously live artifact '
  'serving" is a property of the database. A FUNCTION rather than DML because it crosses the '
  'plane boundary into schema runtime (which `authoring` cannot reach), because the token '
  'mint must have exactly one implementation (R8), and because K §1 puts publish-to-production '
  'on project_manager and publish-to-staging on programmer — a distinction an RLS policy '
  'cannot see, since it observes an UPDATE and not an intent. Returns jsonb rather than OUT '
  'parameters so that adding a field later is not a re-signing: 0005 had to move five '
  'signature assertions when the job RPCs were re-signed, and db/README.md draws the lesson. '
  'The failure path is deliberately NOT here — compile_state = ''failed'' with diagnostics is '
  'an ordinary UPDATE that 0004''s sv_update policy already permits.';

REVOKE EXECUTE ON FUNCTION app.publish_version(app.ulid, app.sha256, bigint,
  app.version_status, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.publish_version(app.ulid, app.sha256, bigint,
  app.version_status, jsonb, jsonb, text) TO authoring;

-- ---------------------------------------------------------------------------
-- 6. app.rollback_version — archived -> production, in one transaction (B §3.1)
-- ---------------------------------------------------------------------------
-- The acceptance criterion, verbatim: "rolling back to the previous version repoints
-- artifact_hash and flips archived -> production in under 5 seconds, and the runtime serves
-- byte-identical bytes to what was live before, verified by hash comparison in the test."
--
-- The second half is the interesting one, and it is bought by ADR-002 rather than by this
-- function: NOTHING HERE REWRITES A VERSION'S artifact_hash. The archived version still names
-- the artifact it named while it was live, the artifact is addressed by the sha256 of its own
-- content, so "byte-identical" follows from the hash never having been touched. What gets
-- repointed is the TOKEN — the row that maps the public URL to a hash — which is why B §3.1's
-- "rollback repoints artifact_hash" reads, in this schema, as "rollback repoints the token
-- and the version's hash was never in question". A rollback that copied bytes, or that
-- rebuilt an artifact, would be a rollback that can produce something that was never live.
CREATE FUNCTION app.rollback_version(p_to_version_id app.ulid, p_request_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_to    app.survey_versions%ROWTYPE;
  v_from  app.ulid;
  v_token runtime.survey_token;
BEGIN
  SELECT * INTO v_to FROM app.survey_versions sv WHERE sv.id = p_to_version_id FOR UPDATE;
  -- K §1 again: rollback changes what respondents see, so it is the project_manager
  -- capability and not the programmer one. Same single message as publish, same reason.
  IF NOT FOUND
     OR v_to.org_id <> app.current_org()
     OR NOT app.has_role('project_manager')
     OR NOT app.can_see_survey(v_to.survey_id) THEN
    RAISE EXCEPTION 'survey version % is not a rollback target for this caller',
      p_to_version_id
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'rollback requires project_manager (Deliverable K §1).';
  END IF;

  IF v_to.status <> 'archived' THEN
    RAISE EXCEPTION 'rollback target % is % and not archived', p_to_version_id, v_to.status
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'rollback is archived -> production. Promoting a draft is '
                   'app.publish_version.';
  END IF;
  -- A version with no usable artifact cannot serve, and app.tg_version_guard would not stop
  -- the promotion: sv_live_needs_compiled checks compile_state and sv_compiled_needs_artifact
  -- checks the hash, but only together do they mean "there are bytes to serve". Checked here
  -- so the error names the rollback rather than a constraint.
  IF v_to.compile_state <> 'compiled' OR v_to.artifact_hash IS NULL THEN
    RAISE EXCEPTION 'rollback target % has no usable artifact (compile_state %)',
      p_to_version_id, v_to.compile_state
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM app.surveys s WHERE s.id = v_to.survey_id FOR UPDATE;

  -- DEMOTE BEFORE PROMOTE, and the order is load-bearing rather than tidy: sv_one_production
  -- is a partial unique index, checked at statement end, so promoting first raises 23505 and
  -- the rollback fails with a message about an index. Two statements in this order, in one
  -- transaction, and the "at most one production version" invariant is never observably
  -- violated. This migration's test.sql asserts that the index is what refuses the second
  -- production row, so nobody later replaces the index with a trigger and a comment.
  UPDATE app.survey_versions sv SET status = 'archived'
   WHERE sv.survey_id = v_to.survey_id AND sv.status = 'production'
  RETURNING sv.id INTO v_from;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'survey % has no production version to roll back from', v_to.survey_id
      USING ERRCODE = 'invalid_parameter_value',
            HINT = 'there is nothing live to replace: publish instead.';
  END IF;

  UPDATE app.survey_versions sv SET status = 'production' WHERE sv.id = v_to.id;

  v_token := runtime.upsert_survey_token(v_to.id, false);

  PERFORM app.write_audit_event(
    p_org_id            => v_to.org_id,
    p_action            => 'version.rolled_back',
    p_actor_kind        => CASE WHEN app.current_user_id() IS NULL THEN 'system'
                                ELSE 'user' END,
    p_target_kind       => 'survey_version',
    p_target_id         => v_to.id,
    p_survey_id         => v_to.survey_id,
    p_survey_version_id => v_to.id,
    p_summary           => format('rolled back to version %s', v_to.version_no),
    p_diff              => jsonb_build_object(
                             'production_version_id',
                             jsonb_build_object('from', v_from, 'to', v_to.id),
                             'artifact_hash', v_to.artifact_hash,
                             'token', v_token),
    p_request_id        => p_request_id);

  RETURN jsonb_build_object(
    'token', v_token,
    'survey_id', v_to.survey_id,
    'from_version_id', v_from,
    'to_version_id', v_to.id,
    'artifact_hash', v_to.artifact_hash);
END $$;
COMMENT ON FUNCTION app.rollback_version(app.ulid, text) IS
  'B §3.1 / P1-08 acceptance: archived -> production plus repointing the token, in one '
  'transaction, in the order the partial unique index requires (demote, then promote). '
  'Deliberately does NOT write artifact_hash on any version: the target still names the '
  'artifact it named while it was live and ADR-002 addresses artifacts by the sha256 of their '
  'own content, so "the runtime serves byte-identical bytes to what was live before" follows '
  'from the hash never having been rewritten. Refuses a target that is not archived (that is '
  'a publish), one with no usable artifact (that is a 500 for a respondent), and a survey '
  'with nothing live to replace (that is also a publish). project_manager floor per K §1. '
  'Rolling FORWARD again is the same call with the other version id, which is what makes '
  '"undo the rollback" not need its own code path.';

REVOKE EXECUTE ON FUNCTION app.rollback_version(app.ulid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rollback_version(app.ulid, text) TO authoring;

-- ---------------------------------------------------------------------------
-- 7. runtime.resolve_token — the placeholder 0004 left for this milestone
-- ---------------------------------------------------------------------------
-- 0004 created this function returning nothing and said so in its comment: "the real
-- implementation reads runtime.survey_tokens in P1-08". This is P1-08. The SIGNATURE IS
-- UNCHANGED — (text) in, (survey_version_id, artifact_hash, is_test, status) out — so per
-- db/README.md's rule 0004 keeps its signature and privilege assertions and this migration
-- takes the behavioural ones; 0004's two "returns no rows" assertions still hold, because an
-- unknown token still resolves to nothing, and its wording is maintained there in this same
-- commit.
--
-- CREATE OR REPLACE preserves the owner (runtime_rpc_owner) and the ACL (EXECUTE to
-- runtime_writer), which is exactly what is wanted and is also why both are restated below:
-- "preserves the ACL" is a property of the statement, not something visible at the call site.
CREATE OR REPLACE FUNCTION runtime.resolve_token(p_token text)
RETURNS TABLE (survey_version_id app.ulid, artifact_hash app.sha256,
               is_test boolean, status app.version_status)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET statement_timeout = '3s' AS $$
BEGIN
  -- Validate before touching anything: the token arrives from a hostname label supplied by
  -- an anonymous respondent. NO lower(), NO trim(), NO normalization of any kind — see this
  -- migration's §1. An uppercase spelling of a real token is NOT that token, and returning
  -- zero rows for it is what makes Deliverable G §3.1's "hostname label and path token match
  -- byte-for-byte, 404 on mismatch" enforceable from both ends.
  IF p_token IS NULL OR p_token !~ '^[0-9a-z]{26}$' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT t.survey_version_id, t.artifact_hash, t.is_test, t.status
      FROM runtime.survey_tokens t
     WHERE t.token = p_token
       AND t.revoked_at IS NULL;
END $$;
COMMENT ON FUNCTION runtime.resolve_token(text) IS
  'B §2 / 01 §3.3 step 1, implemented in P1-08 (it was a placeholder from 0004). The '
  'runtime''s ONE read from Postgres: token -> (survey_version_id, artifact_hash, is_test, '
  'status) and NOTHING ELSE — no org, no survey name, no project — because every extra column '
  'is a cross-tenant leak waiting for a bug. Takes no org_id, because the token IS the '
  'capability and a cross-tenant request is therefore unphraseable rather than merely '
  'unauthorized. SECURITY DEFINER owned by runtime_rpc_owner, search_path pinned, '
  'statement_timeout 3s: an edge caller must fail fast rather than hold a connection while '
  'the control plane is having a bad day. The regex pre-check is not redundant with the '
  'column''s domain — it means a malformed hostname label costs no index lookup — and it must '
  'never be relaxed to case-insensitive matching (risk R8; §1 of this migration). Rows whose '
  'revoked_at is set are invisible here, which is how a retired survey stops serving without '
  'losing the record that its URL once existed.';

ALTER FUNCTION runtime.resolve_token(text) OWNER TO runtime_rpc_owner;
REVOKE EXECUTE ON FUNCTION runtime.resolve_token(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION runtime.resolve_token(text) TO runtime_writer;

-- ---------------------------------------------------------------------------
-- 8. app.survey_tokens_for_version — the control plane's read (H §2.7)
-- ---------------------------------------------------------------------------
-- H §2.7 exposes GET /v1/versions/{id}/tokens at the PM+ floor, returning
-- [{token, status, is_test, revoked_at, entry_url}] — and P1-08's publish dialog and version
-- history need it to show the live URL. The studio cannot read the table: `authoring` holds no
-- USAGE on schema runtime (0001) and this migration grants none, which is ADR-001's plane
-- boundary and not an oversight. So the read is a narrow definer function, filtered by
-- app.current_org() inside the definer — which also gives the ADR-009 property that a forged
-- active_org_id yields ZERO ROWS rather than an error.
--
-- Returns `text` and not runtime.survey_token deliberately: a domain in the signature would
-- require the caller to hold USAGE on schema runtime to resolve it, which is the exact grant
-- this function exists to avoid. (0001 makes the mirror-image note about granting
-- runtime_writer USAGE on `app` purely so app.ulid resolves in the RPC signatures.)
-- entry_url is not here: the hostname pattern is deployment configuration (ADR-005's
-- <token>.run.<domain> and Phase 6's vanity domains), and a database that stores it is a
-- database that has to be migrated to move a domain.
CREATE FUNCTION app.survey_tokens_for_version(p_version_id app.ulid)
RETURNS TABLE (token text, is_test boolean, status app.version_status,
               artifact_hash app.sha256, created_at timestamptz, updated_at timestamptz,
               revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.token::text, t.is_test, t.status, t.artifact_hash, t.created_at, t.updated_at,
         t.revoked_at
    FROM runtime.survey_tokens t
   WHERE t.survey_version_id = p_version_id
     AND t.org_id = app.current_org()
     AND app.has_role('project_manager')
     AND app.can_see_survey(t.survey_id)
   ORDER BY t.is_test, t.created_at
$$;
COMMENT ON FUNCTION app.survey_tokens_for_version(app.ulid) IS
  'H §2.7''s GET /v1/versions/{id}/tokens, at K §1''s PM+ floor. The studio''s only way to '
  'learn a survey''s public URL, because `authoring` has no USAGE on schema runtime and this '
  'migration does not give it any (ADR-001''s plane boundary). Org-scoped INSIDE the definer '
  'against app.current_org(), so a forged active_org_id returns zero rows rather than an '
  'error — P1-01''s acceptance criterion, applied to a function instead of a policy, because '
  'an error is an oracle: it tells the caller the version exists. Returns `text` rather than '
  'runtime.survey_token so the caller needs no privilege in schema runtime to resolve the '
  'return type. Includes revoked tokens on purpose: "this link is dead" is the answer the '
  'support desk needs, and it is not the same answer as an empty list.';

REVOKE EXECUTE ON FUNCTION app.survey_tokens_for_version(app.ulid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.survey_tokens_for_version(app.ulid) TO authoring;

-- ---------------------------------------------------------------------------
-- 9. app.survey_versions: the two JSONB columns P1-08 starts writing
-- ---------------------------------------------------------------------------
-- No new columns (see §0). What the columns did not have is a shape, because until this
-- milestone nothing wrote them. `jsonb NOT NULL` accepts the JSON scalar `null`, which is not
-- SQL NULL and passes NOT NULL while being exactly as unusable — 0008 made the same argument
-- for content.logic_rules.condition. Here the consumer is the publish dialog, which iterates
-- diagnostics to separate errors from warnings, and the audit trail, which has to answer "who
-- signed off on shipping this": both read an ARRAY, and `null` or an object would be an
-- exception in the one code path a user reaches while trying to ship.
--
-- Added NOT VALID and then validated in a second statement, which is B §14's expand pattern
-- rather than pedantry: ADD CONSTRAINT alone takes ACCESS EXCLUSIVE for the duration of a
-- full table scan, while NOT VALID takes it only briefly and VALIDATE CONSTRAINT then runs
-- under SHARE UPDATE EXCLUSIVE, which does not block readers or writers. On today's row
-- counts the difference is unmeasurable; the point is that the pattern is the one in the file
-- when somebody copies it onto a table with 40 million rows.
ALTER TABLE app.survey_versions
  ADD CONSTRAINT sv_diagnostics_is_array
  CHECK (jsonb_typeof(compile_diagnostics) = 'array') NOT VALID;
ALTER TABLE app.survey_versions VALIDATE CONSTRAINT sv_diagnostics_is_array;
ALTER TABLE app.survey_versions
  ADD CONSTRAINT sv_ack_warnings_is_array
  CHECK (jsonb_typeof(acknowledged_warnings) = 'array') NOT VALID;
ALTER TABLE app.survey_versions VALIDATE CONSTRAINT sv_ack_warnings_is_array;

COMMENT ON CONSTRAINT sv_diagnostics_is_array ON app.survey_versions IS
  'C §17 / D §8: compile_diagnostics is a LIST of diagnostics, each carrying a code, a '
  'severity and a path. A jsonb scalar `null` satisfies NOT NULL and is exactly as '
  'unrenderable, and the code that would hit it is the publish dialog — the screen a user is '
  'looking at while trying to ship. Added in 0009 rather than 0004 because P1-08 is the '
  'milestone that starts writing the column, and a column nothing writes has no shape to '
  'constrain yet.';
COMMENT ON CONSTRAINT sv_ack_warnings_is_array ON app.survey_versions IS
  'The same for 03 §17''s acknowledgements. This one is additionally SEALED by '
  'app.tg_version_guard once the version is frozen, which is what makes it evidence: '
  '"who signed off on shipping this warning" cannot be rewritten after the fact.';

COMMENT ON COLUMN app.survey_versions.compile_diagnostics IS
  'C §17 / D §8''s static-gate output for the LAST compile of this version: the array the '
  'publish dialog splits into errors and warnings. Written by app.publish_version on success '
  'and by an ordinary UPDATE (0004''s sv_update policy, programmer floor) when a compile '
  'fails — the failure path deliberately has no RPC of its own, because K §3 requires it to '
  'change nothing else. Diagnostics are kept on the VERSION rather than on the ops.jobs row '
  'that produced them: the job is retained for a while and the version is retained forever, '
  'and "why can I not publish this" outlives any queue.';
COMMENT ON COLUMN app.survey_versions.artifact_bytes IS
  'Size of the compiled artifact whose sha256 is artifact_hash. Not derivable from anything '
  'in this database — the bytes live in object storage — and worth a column because it is the '
  'number that answers "why did the runtime''s cold start regress" and the number an '
  'entitlement check compares against. NULL means "no artifact", which is the same thing '
  'artifact_hash IS NULL means; the pair is kept honest by sv_compiled_needs_artifact.';
