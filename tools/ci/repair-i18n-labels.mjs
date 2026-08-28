#!/usr/bin/env node
/**
 * Repair labels authored before `label_text` existed.
 *
 * The studio used to send the author's typed prose in the `label` field, which `PATCH /nodes/:id`
 * mapped straight onto `label_key`. So a survey's labels are sentences sitting in a key column with
 * nothing in `content.i18n_strings` behind them, and 03 §16 resolves every string through that
 * table — which is why such a survey fails to publish with one `SCH-1008` per label, each naming a
 * key that is visibly prose.
 *
 * Migration 0028 and the `label_text` field fix authoring from here on. They do nothing for rows
 * already written. This does those.
 *
 * ## What it does, and in what order
 *
 *  1. **The base language, first, because everything else needs it.** These versions predate the
 *     fix that seeds `content.languages` at creation, so they have NO base language — and
 *     `content.set_node_label` correctly REFUSES to run without one rather than defaulting to `en`
 *     (defaulting is what made the compiler report a bundle that did not exist). Nothing else in
 *     this script can work until the row exists.
 *
 *  2. **Node labels, instructions and titles, and item labels, through
 *     `content.set_node_label` / `content.set_item_label`** — passing the CURRENT KEY as the TEXT,
 *     because the current key IS the text the author typed. Going through the audited functions
 *     rather than writing INSERTs by hand means the repair gets the same key policy as a fresh
 *     edit: a sentence or markup is replaced with a key minted from the row's immutable id, and a
 *     value that is indistinguishable from a deliberate key (`"Apple"`) is kept and given a bundle
 *     row. The result is data a later edit will not churn.
 *
 *  3. **Variable keys directly**, and this is the one place the repair is cosmetically worse.
 *     `content.variables` carries `export_label_key` and a `label_key` inside each `enum_domain`
 *     entry, and there is no helper for those — nothing in the API sets them from prose. So the
 *     bundle row is written with `key = value = the existing string`. The reference resolves and
 *     the survey publishes; the key stays whatever it was. Minting new keys here would mean
 *     rewriting a jsonb column that the compiler's variable derivation also reads, which is a
 *     bigger change than a repair script should make.
 *
 * ## Safety
 *
 * Dry run by default: it prints every change and writes nothing. `--apply` performs them, one
 * transaction per version, so a failure leaves that version untouched rather than half-repaired.
 * Only DRAFT versions are touched — `content.tg_draft_only` would refuse a published one anyway
 * (ADR-002 freezes content on publish), and a frozen version needs a clone, not a repair.
 *
 * Idempotent: a second run finds nothing to do, because step 2's functions reuse the keys they
 * minted and step 3's insert is an upsert.
 *
 * Usage:
 *   DATABASE_URL=… node tools/ci/repair-i18n-labels.mjs                 # dry run, all drafts
 *   DATABASE_URL=… node tools/ci/repair-i18n-labels.mjs --version ver_…  # one version
 *   DATABASE_URL=… node tools/ci/repair-i18n-labels.mjs --apply
 *   DATABASE_URL=… node tools/ci/repair-i18n-labels.mjs --apply --lang de
 */

import process from 'node:process';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const val = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const APPLY = has('apply');
const ONLY_VERSION = val('version', null);
const BASE_LANG = val('lang', 'en');

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

/** Prose, or a key? The same test `content.i18n_key_shaped` applies, kept in step deliberately. */
const KEY_SHAPED = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

const plan = [];
let repaired = 0;

try {
  const versions = await pool.query(
    `SELECT v.id, v.org_id, v.status,
            (SELECT count(*) FROM content.languages l
              WHERE l.survey_version_id = v.id AND l.is_base) AS base_langs
       FROM app.survey_versions v
      WHERE v.status = 'draft'
        AND ($1::text IS NULL OR v.id = $1::text)
      ORDER BY v.created_at`,
    [ONLY_VERSION],
  );

  if (versions.rows.length === 0) {
    console.log('No draft versions matched. A published version cannot be repaired in place —');
    console.log('ADR-002 freezes its content, so it needs a clone.');
    process.exit(0);
  }

  for (const v of versions.rows) {
    const versionId = v.id;
    console.log(`\nversion ${versionId}  (org ${v.org_id})`);

    const needsBase = Number(v.base_langs) === 0;
    if (needsBase) {
      console.log(`  + base language '${BASE_LANG}' — this version has none, and set_node_label`);
      console.log('    refuses to run without one rather than defaulting');
      plan.push({ versionId, kind: 'language' });
    }

    const nodes = await pool.query(
      `SELECT id, label_key, instruction_key, title_key
         FROM content.nodes
        WHERE survey_version_id = $1 AND deleted_at IS NULL
          AND (label_key IS NOT NULL OR instruction_key IS NOT NULL OR title_key IS NOT NULL)
        ORDER BY sort_key`,
      [versionId],
    );
    const items = await pool.query(
      `SELECT id, label_key FROM content.question_items
        WHERE survey_version_id = $1 AND label_key IS NOT NULL
        ORDER BY sort_key`,
      [versionId],
    );
    const strings = await pool.query(
      'SELECT key FROM content.i18n_strings WHERE survey_version_id = $1 AND lang = $2',
      [versionId, BASE_LANG],
    );
    const have = new Set(strings.rows.map((r) => r.key));

    for (const n of nodes.rows) {
      for (const field of ['label', 'instruction', 'title']) {
        const current = n[`${field}_key`];
        if (typeof current !== 'string' || current === '') continue;
        // Already resolvable: a key-shaped value WITH a bundle row needs nothing.
        if (KEY_SHAPED.test(current) && have.has(current)) continue;
        console.log(
          `  ~ node ${n.id} ${field}: ${KEY_SHAPED.test(current) ? 'key with no string' : 'PROSE'}` +
            ` — ${JSON.stringify(current.slice(0, 60))}`,
        );
        plan.push({ versionId, kind: 'node', id: n.id, field, text: current });
      }
    }

    for (const it of items.rows) {
      const current = it.label_key;
      if (typeof current !== 'string' || current === '') continue;
      if (KEY_SHAPED.test(current) && have.has(current)) continue;
      console.log(
        `  ~ item ${it.id} label: ${KEY_SHAPED.test(current) ? 'key with no string' : 'PROSE'}` +
          ` — ${JSON.stringify(current.slice(0, 60))}`,
      );
      plan.push({ versionId, kind: 'item', id: it.id, text: current });
    }

    // Variable keys: no helper exists, so the key is kept and given a row. See the header.
    const varKeys = await pool.query(
      `SELECT DISTINCT k AS key FROM (
         SELECT export_label_key AS k FROM content.variables
          WHERE survey_version_id = $1 AND export_label_key IS NOT NULL
         UNION
         SELECT e.value ->> 'label_key' FROM content.variables v,
                jsonb_array_elements(v.enum_domain) e
          WHERE v.survey_version_id = $1 AND v.enum_domain IS NOT NULL
            AND e.value ->> 'label_key' IS NOT NULL
       ) t WHERE k IS NOT NULL AND k <> ''`,
      [versionId],
    );
    for (const row of varKeys.rows) {
      if (have.has(row.key)) continue;
      console.log(`  + string for variable key ${JSON.stringify(row.key.slice(0, 60))}`);
      plan.push({ versionId, kind: 'varkey', key: row.key, orgId: v.org_id });
    }
  }

  console.log(`\n${String(plan.length)} change(s) planned.`);
  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to perform them.');
    process.exit(0);
  }

  // One transaction per version: a failure leaves that version untouched rather than half done.
  const byVersion = new Map();
  for (const step of plan) {
    if (!byVersion.has(step.versionId)) byVersion.set(step.versionId, []);
    byVersion.get(step.versionId).push(step);
  }

  for (const [versionId, steps] of byVersion) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const step of steps) {
        if (step.kind === 'language') {
          await client.query(
            `INSERT INTO content.languages (survey_version_id, lang, org_id, is_base)
             SELECT v.id, $2, v.org_id, true FROM app.survey_versions v WHERE v.id = $1
             ON CONFLICT (survey_version_id, lang) DO NOTHING`,
            [versionId, BASE_LANG],
          );
        } else if (step.kind === 'node') {
          await client.query('SELECT content.set_node_label($1, $2, $3, $4)', [
            versionId, step.id, step.field, step.text,
          ]);
        } else if (step.kind === 'item') {
          await client.query('SELECT content.set_item_label($1, $2, $3)', [
            versionId, step.id, step.text,
          ]);
        } else {
          await client.query(
            `INSERT INTO content.i18n_strings
               (survey_version_id, lang, key, value, state, org_id)
             VALUES ($1, $2, $3, $3, 'reviewed', $4)
             ON CONFLICT (survey_version_id, lang, key)
               DO UPDATE SET value = excluded.value, state = 'reviewed'`,
            [versionId, BASE_LANG, step.key, step.orgId],
          );
        }
        repaired += 1;
      }
      await client.query('COMMIT');
      console.log(`applied ${String(steps.length)} change(s) to ${versionId}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`FAILED on ${versionId} — rolled back, nothing changed for it:`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  }

  console.log(`\n${String(repaired)} change(s) written.`);
  console.log('Now re-publish each version. Any remaining diagnostic is a real one.');
} finally {
  await pool.end().catch(() => undefined);
}
