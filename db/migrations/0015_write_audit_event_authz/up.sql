-- 0015_write_audit_event_authz — app.write_audit_event actually callable, safely.
--
-- 0004 revoked EXECUTE on app.write_audit_event from PUBLIC and never granted it back to
-- anyone (the header comment there says "audit writes from SECURITY DEFINER functions
-- only"). That was true for the THREE routes that call it from inside another
-- SECURITY DEFINER function's body (app.create_organization, app.publish_version,
-- app.rollback_version) — those already run as the migrating role, which implicitly has
-- EXECUTE on everything it owns. It was never true for the application layer: EVERY
-- create/update/delete route in the API catalogue logs through the generic
-- `ctx.repos.audit.write()` helper (apps/studio/src/server/repo/supabase.ts), which calls
-- this function directly, as `authoring`, over PostgREST. Against a real (non-superuser)
-- Postgres role — as opposed to the bare-Postgres-superuser CI path that never caught this —
-- every one of those routes fails with "permission denied for function write_audit_event"
-- the first time it is exercised. That is effectively the whole write surface of the
-- application.
--
-- The fix is not a bare GRANT: app.write_audit_event takes p_org_id as a plain argument with
-- no check that the caller has any standing in that org — it was written on the assumption
-- that only trusted, already-authorized SECURITY DEFINER callers would ever reach it.
-- Granting EXECUTE to `authoring` unconditionally would let any authenticated user forge an
-- audit row in ANY org's log by naming an arbitrary p_org_id, which is a worse hole than the
-- one this migration closes. So this migration adds the same predicate every RLS policy in
-- this schema already uses — org membership — as an explicit guard inside the function body,
-- then grants EXECUTE. Every existing call site already only ever names the caller's own
-- active org, or (the two documented exceptions: org-switch and invitation-accept) an org the
-- caller has just been confirmed a member of, in the same transaction, before this function is
-- called — see apps/studio/src/app/api/v1/orgs/[id]/switch/route.ts and
-- .../invitations/accept/route.ts. So the guard changes nothing for any legitimate caller.
--
-- Migration header first (B §14, read by tools/ci/lint-migrations.mjs from the first 60
-- lines). Expand-only: replaces one function's body (same signature, same return type) and
-- adds one grant. No tables, no renames, no in-place type changes, no defaults materialized
-- over existing rows.
SET lock_timeout = '3s';
SET statement_timeout = '120s';

CREATE OR REPLACE FUNCTION app.write_audit_event(
  p_org_id            app.ulid,
  p_action            text,
  p_actor_kind        text DEFAULT 'user',
  p_actor_user_id     uuid DEFAULT NULL,
  p_target_kind       text DEFAULT NULL,
  p_target_id         app.ulid DEFAULT NULL,
  p_project_id        app.ulid DEFAULT NULL,
  p_survey_id         app.ulid DEFAULT NULL,
  p_survey_version_id app.ulid DEFAULT NULL,
  p_summary           text DEFAULT NULL,
  p_diff              jsonb DEFAULT NULL,
  p_request_id        text DEFAULT NULL
) RETURNS app.ulid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id app.ulid;
BEGIN
  -- The caller must at least be a member of the org they are writing an audit event for.
  -- 'viewer' is the lowest rank in app.org_role (0002), so this is "any member at all", not
  -- a role floor — the actual action that produced this audit event was already authorized
  -- by the route/RLS policy that performed it; this check exists solely to stop p_org_id
  -- from being an open oracle. app.has_role() is itself SECURITY DEFINER and reads auth.uid()
  -- from the JWT claim, exactly like every RLS policy in this schema.
  IF NOT app.has_role('viewer', p_org_id) THEN
    RAISE EXCEPTION 'not a member of organization %', p_org_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO app.audit_log (org_id, action, actor_kind, actor_user_id, target_kind,
                             target_id, project_id, survey_id, survey_version_id,
                             summary, diff, request_id)
  VALUES (p_org_id, p_action, p_actor_kind,
          COALESCE(p_actor_user_id, app.current_user_id()), p_target_kind, p_target_id,
          p_project_id, p_survey_id, p_survey_version_id, p_summary, p_diff, p_request_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION app.write_audit_event(app.ulid, text, text, uuid, text, app.ulid,
  app.ulid, app.ulid, app.ulid, text, jsonb, text) IS
  'B §12 / P1-01: "audit writes from SECURITY DEFINER functions only." app.audit_log has a '
  'SELECT policy and no INSERT policy, so this function is the only way a row gets in. '
  '0015: also the only role-agnostic entry point the application layer calls directly, so '
  'it re-checks org membership on p_org_id itself (has_role floor ''viewer'') rather than '
  'trusting every caller to have checked already.';

-- The grant 0004 never issued. Every create/update/delete route's audit write needs this.
GRANT EXECUTE ON FUNCTION app.write_audit_event(app.ulid, text, text, uuid, text, app.ulid,
  app.ulid, app.ulid, app.ulid, text, jsonb, text) TO authoring;

-- ---------------------------------------------------------------------------
-- ops.test_seed_two_orgs also calls app.write_audit_event, from a plain superuser SQL
-- session with no JWT claims set at all (pg_prove runs test.sql directly, never through
-- PostgREST) — a situation that cannot occur in real production traffic, where every
-- request (direct RPC or from inside another SECURITY DEFINER function) always carries the
-- caller's JWT. Without a claim, auth.uid() is NULL, has_role() is correctly false for
-- everyone, and the new guard above rejects the seed's own audit rows — which is why every
-- pgTAP file using this fixture failed the moment 0015's guard was added. Fixed the same
-- way real traffic already satisfies the guard: set the acting user's claim immediately
-- before each write_audit_event call, matching who the seed data says did it.
CREATE OR REPLACE FUNCTION ops.test_seed_two_orgs() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user_a  uuid := '11111111-1111-1111-1111-111111111111';
  v_user_a2 uuid := '44444444-4444-4444-4444-444444444444';
  v_user_b  uuid := '22222222-2222-2222-2222-222222222222';
  v_user_b2 uuid := '55555555-5555-5555-5555-555555555555';
  v_user_c  uuid := '33333333-3333-3333-3333-333333333333';
  v_org_a   app.ulid := ops.test_ulid('org', 'a');
  v_org_b   app.ulid := ops.test_ulid('org', 'b');
  v_prj_a   app.ulid := ops.test_ulid('prj', 'a');
  v_prj_a2  app.ulid := ops.test_ulid('prj', 'a2');
  v_prj_b   app.ulid := ops.test_ulid('prj', 'b');
  v_svy_a   app.ulid := ops.test_ulid('svy', 'a');
  v_svy_b   app.ulid := ops.test_ulid('svy', 'b');
  v_ver_a1  app.ulid := ops.test_ulid('ver', 'a1');   -- frozen, production
  v_ver_a2  app.ulid := ops.test_ulid('ver', 'a2');   -- draft
  v_ver_b1  app.ulid := ops.test_ulid('ver', 'b1');   -- frozen, production
  v_ver_b2  app.ulid := ops.test_ulid('ver', 'b2');   -- draft
  k_hash    constant app.sha256 :=
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a,  'a@example.test'),
    (v_user_a2, 'a2@example.test'),
    (v_user_b,  'b@example.test'),
    (v_user_b2, 'b2@example.test'),
    (v_user_c,  'c@example.test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO app.organizations (id, slug, name, settings) VALUES
    (v_org_a, 'org-a', 'Org A', '{"pii_exports_enabled": true}'),
    (v_org_b, 'org-b', 'Org B', '{}');

  -- user_a owns org A org-wide; user_a2 is a reviewer scoped to project A only, which is
  -- what makes can_see_project() testable rather than vacuously true; user_b owns org B;
  -- user_c belongs to NOTHING, which is the forged-claim case.
  INSERT INTO app.org_members (org_id, user_id, role, project_ids) VALUES
    (v_org_a, v_user_a,  'owner',    '{}'),
    (v_org_a, v_user_a2, 'reviewer', ARRAY[v_prj_a]::app.ulid[]),
    (v_org_b, v_user_b,  'owner',    '{}'),
    (v_org_b, v_user_b2, 'programmer', ARRAY[v_prj_b]::app.ulid[]);

  INSERT INTO app.projects (id, org_id, ref, name, created_by) VALUES
    (v_prj_a,  v_org_a, 'PRJA',  'Project A',  v_user_a),
    (v_prj_a2, v_org_a, 'PRJA2', 'Project A2', v_user_a),
    (v_prj_b,  v_org_b, 'PRJB',  'Project B',  v_user_b);

  INSERT INTO app.surveys (id, org_id, project_id, ref, name, created_by) VALUES
    (v_svy_a, v_org_a, v_prj_a, 'SVYA', 'Survey A', v_user_a),
    (v_svy_b, v_org_b, v_prj_b, 'SVYB', 'Survey B', v_user_b);

  -- One frozen production version and one draft per survey: the frozen one is what the
  -- immutability tests write against, the draft is what the happy path writes against.
  INSERT INTO app.survey_versions
    (id, org_id, survey_id, version_no, status, compile_state, artifact_hash,
     schema_version, created_by, frozen_at, published_at) VALUES
    (v_ver_a1, v_org_a, v_svy_a, 1, 'production', 'compiled', k_hash, 1, v_user_a,
     now(), now()),
    (v_ver_b1, v_org_b, v_svy_b, 1, 'production', 'compiled', k_hash, 1, v_user_b,
     now(), now());
  INSERT INTO app.survey_versions
    (id, org_id, survey_id, version_no, status, compile_state, schema_version, created_by,
     cloned_from_version_id) VALUES
    (v_ver_a2, v_org_a, v_svy_a, 2, 'draft', 'none', 1, v_user_a, v_ver_a1),
    (v_ver_b2, v_org_b, v_svy_b, 2, 'draft', 'none', 1, v_user_b, v_ver_b1);

  INSERT INTO app.invitations (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (v_org_a, 'invitee-a@example.test', 'analyst',
          app.hash_invitation_token('token-for-org-a'), v_user_a, now() + interval '7 days'),
         (v_org_b, 'invitee-b@example.test', 'analyst',
          app.hash_invitation_token('token-for-org-b'), v_user_b, now() + interval '7 days');

  -- user_a has PII access in org A (and org A's settings permit it); nobody has it in
  -- org B, and org B's settings do not permit it either. Two independent reasons, so the
  -- test can tell which one is doing the work.
  INSERT INTO app.capability_grants
    (org_id, user_id, capability, project_id, granted_by, justification) VALUES
    (v_org_a, v_user_a2, 'pii_access', v_prj_a, v_user_a,
     'Fieldwork QA for project A, approved in ticket SEC-1041'),
    -- Org B gets a grant too, so that every org_id-bearing table has at least one org-B
    -- row and the catalog-walking cross-tenant probe in test.sql is never vacuous for
    -- one of them. custom_code rather than pii_access: it needs no org setting, so the
    -- two capabilities are exercised independently.
    (v_org_b, v_user_b2, 'custom_code', v_prj_b, v_user_b,
     'Screener randomisation script for project B, approved in ticket SEC-2077');

  -- 0015: write_audit_event now checks that the CALLER (auth.uid(), from the live JWT
  -- claim) is a member of p_org_id. This function runs from pg_prove with no JWT at all,
  -- so set the claim to whichever seeded user this row is attributed to — org_members
  -- already has that row from the INSERT above, so the check passes exactly as it would
  -- for a real request landing one statement after the membership it depends on.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a)::text, true);
  PERFORM app.write_audit_event(v_org_a, 'seed.created', 'system', v_user_a,
                                'organization', v_org_a, v_prj_a, v_svy_a, v_ver_a1,
                                'org A seeded');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_b)::text, true);
  PERFORM app.write_audit_event(v_org_b, 'seed.created', 'system', v_user_b,
                                'organization', v_org_b, v_prj_b, v_svy_b, v_ver_b1,
                                'org B seeded');
  PERFORM set_config('request.jwt.claims', '', true);

  RETURN jsonb_build_object(
    'user_a', v_user_a, 'user_a2', v_user_a2,
    'user_b', v_user_b, 'user_b2', v_user_b2, 'user_c', v_user_c,
    'org_a', v_org_a, 'org_b', v_org_b,
    'prj_a', v_prj_a, 'prj_a2', v_prj_a2, 'prj_b', v_prj_b,
    'svy_a', v_svy_a, 'svy_b', v_svy_b,
    'ver_a_frozen', v_ver_a1, 'ver_a_draft', v_ver_a2,
    'ver_b_frozen', v_ver_b1, 'ver_b_draft', v_ver_b2);
END $$;
