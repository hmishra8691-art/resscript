-- 0028_label_text — one call sets a label's key AND its base-language string.

SET lock_timeout = '3s';
SET statement_timeout = '120s';

-- ## The defect
--
-- 03 §16 makes every user-visible string a `{ "key": … }` reference resolved against the base
-- language bundle, and `http/schemas.ts` says so at the wire: "A label as an I18N KEY, not as
-- prose … the text arrives through `PUT /versions/{id}/translations/{lang}`".
--
-- The studio's inspector sends the author's typed prose in that field. `PATCH /v1/nodes/{id}` maps
-- `value.label` straight onto `label_key`, so typing "Which is your favourite fruit?" stores that
-- sentence as the i18n key — and nothing ever writes the bundle row it points at, because
-- `upsertStrings` is called from exactly one place, the translations route, which the inspector
-- does not call.
--
-- The result is that every label in every survey authored through the UI is a dangling reference. A
-- four-question survey failed to publish with twenty-one `SCH-1008` diagnostics, each naming a key
-- that is visibly a sentence: `i18n key "Apple" is not present in the base language bundle (en)`.
-- The compiler was right every time.
--
-- ## Why a function, and why SECURITY INVOKER
--
-- Setting a label is two writes — the key onto the content row, the text into
-- `content.i18n_strings` — and they must not be separable. `supabase-js` cannot open a transaction,
-- so a repository that did both would leave a dangling key whenever the second call failed, which
-- is precisely the state this migration exists to remove.
--
-- INVOKER, deliberately, unlike most functions in this schema. The point here is atomicity, not
-- privilege: the caller's RLS policies on `content.nodes`, `content.question_items` and
-- `content.i18n_strings` must all still apply, `content.tg_draft_only` must still refuse a frozen
-- version, and `authoring` already holds the grants this needs. A DEFINER function would quietly
-- become a way to edit any version in any org.
--
-- ## The key is minted once and then reused, which is the whole point
--
-- A key that changed when the label was edited would orphan every translation of it — the
-- translator's work would silently detach on a typo fix. So:
--
--   * an existing KEY-SHAPED value is reused, whoever set it (an API consumer managing its own
--     keys owns that key, and this function must not renumber it);
--   * anything else — NULL, or the prose that the studio has been writing — mints a fresh key.
--
-- "Key-shaped" is `^[A-Za-z0-9][A-Za-z0-9._:-]*$`: no whitespace, no angle brackets. That is not a
-- guess about aesthetics, it is the set of things `JSON.stringify` will not have to escape and a
-- translation vendor's CSV will not mangle. `"Which is your favourite fruit?"` fails it; `q.s1.label`
-- passes.
--
-- The minted form is `<field>.<id>` — derived from the row's id, which is immutable, rather than
-- from its `ref`, which is not. A ref rename would otherwise orphan translations, and renaming a
-- question is a thing programmers do constantly. It is not pretty in a translation grid; 09 §10.4
-- already groups that grid by node and links each row back to its question, so the key does not
-- have to carry the context.
--
-- ## `reviewed`, not `translated`
--
-- The base language's text is not a translation of anything — it is the source the translations are
-- made from, typed by the author. `translated` would understate it and `machine` would be false;
-- both count as incomplete in `i18n_incomplete_idx`, which gates publish, so a base string marked
-- either would block the publish it was just written to enable.

CREATE FUNCTION content.i18n_key_shaped(p_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS
$$ SELECT p_key IS NOT NULL AND p_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' $$;

COMMENT ON FUNCTION content.i18n_key_shaped(text) IS
  'Does this value look like an i18n key rather than like prose? Used to decide whether an existing '
  'label_key can be reused or must be replaced — the studio has been storing sentences in that '
  'column, and reusing one would keep the dangling reference alive.';

REVOKE ALL ON FUNCTION content.i18n_key_shaped(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.i18n_key_shaped(text) TO authoring;

/* ------------------------------------------------------------------ *
 * The base language of a version
 * ------------------------------------------------------------------ */

CREATE FUNCTION content.base_language(p_survey_version_id app.ulid) RETURNS text
LANGUAGE sql STABLE AS
$$ SELECT l.lang FROM content.languages l
    WHERE l.survey_version_id = p_survey_version_id AND l.is_base $$;

COMMENT ON FUNCTION content.base_language(app.ulid) IS
  'The version''s base language, or NULL when it has none — which used to be every version, since '
  'nothing created the base row until the studio''s createVersion was fixed. Callers must treat '
  'NULL as an error rather than defaulting to en: a survey with no base language cannot resolve any '
  'string, and inventing one is what made the compiler report a bundle that did not exist.';

REVOKE ALL ON FUNCTION content.base_language(app.ulid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.base_language(app.ulid) TO authoring;

/* ------------------------------------------------------------------ *
 * A node's label / instruction / title
 * ------------------------------------------------------------------ */

CREATE FUNCTION content.set_node_label(
  p_survey_version_id app.ulid,
  p_node_id           app.ulid,
  p_field             text,
  p_text              text
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = '' AS $$
DECLARE
  v_lang     text;
  v_existing text;
  v_key      text;
  v_org      app.ulid;
BEGIN
  IF p_field NOT IN ('label', 'instruction', 'title') THEN
    RAISE EXCEPTION 'set_node_label: unknown field %', p_field
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_lang := content.base_language(p_survey_version_id);
  IF v_lang IS NULL THEN
    RAISE EXCEPTION 'survey version % has no base language, so no string can resolve',
      p_survey_version_id
      USING ERRCODE = 'invalid_parameter_value',
            HINT = '03 §16: every label is a key into the base bundle. Create the base language '
                   'first — a version created through the API gets one.';
  END IF;

  -- The org comes from the row, never from the caller. Reading it here also means a node the
  -- caller's policies hide is simply not found, rather than being written to.
  SELECT n.org_id,
         CASE p_field WHEN 'label' THEN n.label_key
                      WHEN 'instruction' THEN n.instruction_key
                      ELSE n.title_key END
    INTO v_org, v_existing
    FROM content.nodes n
   WHERE n.survey_version_id = p_survey_version_id AND n.id = p_node_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'node % not found in version %', p_node_id, p_survey_version_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_key := CASE WHEN content.i18n_key_shaped(v_existing)
                THEN v_existing
                ELSE p_field || '.' || p_node_id END;

  INSERT INTO content.i18n_strings (survey_version_id, lang, key, value, state, org_id)
  VALUES (p_survey_version_id, v_lang, v_key, p_text, 'reviewed', v_org)
  ON CONFLICT (survey_version_id, lang, key)
    DO UPDATE SET value = excluded.value, state = 'reviewed', updated_at = now();

  IF p_field = 'label' THEN
    UPDATE content.nodes SET label_key = v_key
     WHERE survey_version_id = p_survey_version_id AND id = p_node_id;
  ELSIF p_field = 'instruction' THEN
    UPDATE content.nodes SET instruction_key = v_key
     WHERE survey_version_id = p_survey_version_id AND id = p_node_id;
  ELSE
    UPDATE content.nodes SET title_key = v_key
     WHERE survey_version_id = p_survey_version_id AND id = p_node_id;
  END IF;

  RETURN v_key;
END $$;

COMMENT ON FUNCTION content.set_node_label(app.ulid, app.ulid, text, text) IS
  'Sets a node''s label/instruction/title from PROSE, in one transaction: mints or reuses the i18n '
  'key, writes the base-language string, and points the column at it. SECURITY INVOKER on purpose '
  '— the caller''s RLS and content.tg_draft_only must both still apply; the reason this is a '
  'function is atomicity, not privilege. Returns the key it used.';

REVOKE ALL ON FUNCTION content.set_node_label(app.ulid, app.ulid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.set_node_label(app.ulid, app.ulid, text, text) TO authoring;

/* ------------------------------------------------------------------ *
 * A question item's label
 * ------------------------------------------------------------------ */

CREATE FUNCTION content.set_item_label(
  p_survey_version_id app.ulid,
  p_item_id           app.ulid,
  p_text              text
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = '' AS $$
DECLARE
  v_lang     text;
  v_existing text;
  v_key      text;
  v_org      app.ulid;
BEGIN
  v_lang := content.base_language(p_survey_version_id);
  IF v_lang IS NULL THEN
    RAISE EXCEPTION 'survey version % has no base language, so no string can resolve',
      p_survey_version_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT i.org_id, i.label_key INTO v_org, v_existing
    FROM content.question_items i
   WHERE i.survey_version_id = p_survey_version_id AND i.id = p_item_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'question item % not found in version %', p_item_id, p_survey_version_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_key := CASE WHEN content.i18n_key_shaped(v_existing)
                THEN v_existing
                ELSE 'item.' || p_item_id END;

  INSERT INTO content.i18n_strings (survey_version_id, lang, key, value, state, org_id)
  VALUES (p_survey_version_id, v_lang, v_key, p_text, 'reviewed', v_org)
  ON CONFLICT (survey_version_id, lang, key)
    DO UPDATE SET value = excluded.value, state = 'reviewed', updated_at = now();

  UPDATE content.question_items SET label_key = v_key
   WHERE survey_version_id = p_survey_version_id AND id = p_item_id;

  RETURN v_key;
END $$;

COMMENT ON FUNCTION content.set_item_label(app.ulid, app.ulid, text) IS
  'The option/row/column twin of set_node_label. Every option label in every survey authored '
  'through the studio was a dangling key before this existed — "Apple", "Mango", "Banana" stored '
  'as i18n keys with no bundle row behind them.';

REVOKE ALL ON FUNCTION content.set_item_label(app.ulid, app.ulid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content.set_item_label(app.ulid, app.ulid, text) TO authoring;
