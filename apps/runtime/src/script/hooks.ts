/**
 * The bridge between the submit pipeline (E §5 step 6) and the QuickJS host (E §13).
 *
 * `makeHookRunner` inspects the artifact's `script_bindings` dispatch table and returns a
 * runner only when this artifact actually declares server `onPageSubmit` scripts — the common
 * survey has none, and the pipeline skips the step entirely rather than paying an await to
 * discover nothing.
 *
 * The failure policy lives here, and it is E §13.3's: **fail-open**. A customer's enrichment
 * script dying must not strand a live respondent; the effects are simply absent and a
 * `script.failed` event names the asset, the reason, and the budgets it burned. (`critical:
 * true` fail-closed is specified by E §13.3 but has no schema field on `ScriptAsset` to carry
 * it — recorded as a C §11 erratum in the status doc; until the field exists every script is
 * non-critical, which is E's own default.)
 *
 * One schema gap surfaces here rather than being papered over: `ScriptAsset.scope` says
 * 'page' or 'question' but the schema gives those scopes no TARGET — there is no page_id or
 * question_id on the asset, so "run on this page's submit" is unexpressible. Survey-scoped
 * bindings run on every page submit (their declared meaning); page/question-scoped ones are
 * skipped with a `script.skipped` event, because guessing "every page" for a page-scoped
 * script would run customer code in places its author never intended.
 */

import { createLogger } from '@resscript/observability';
import type { ArtifactHead, ArtifactLoader } from '../artifact/loader.js';
import type { SessionState } from '../session/types.js';
import type { HookRunResult } from '../submit.js';
import { type ScriptHost } from './host.js';

const log = createLogger({ service: 'runtime-scripts' });

type Runner = (session: SessionState, pageId: string) => Promise<HookRunResult>;

export function makeHookRunner(
  host: ScriptHost,
  artifacts: ArtifactLoader,
  head: ArtifactHead,
): Runner | undefined {
  const declared = head.manifest.script_bindings ?? [];
  const server = declared.filter(b => b.runs_on === 'server' && b.hooks.includes('onPageSubmit'));
  if (server.length === 0) return undefined;

  const runnable = server.filter(b => b.scope === 'survey');
  const unbound = server.filter(b => b.scope !== 'survey');

  // ref ↔ id views over the manifest, built once per runner.
  const byRef = new Map(head.manifest.variable_manifest.map(e => [e.name, e]));
  const idOf = (ref: string) => byRef.get(ref)?.id;

  return async (session, pageId) => {
    const writes: Record<string, unknown> = {};
    const write_provenance: Record<string, string> = {};
    const flags: string[] = [];
    const events: Record<string, unknown>[] = [];
    let terminate: HookRunResult['terminate'] = null;
    let reject: string | null = null;

    for (const b of unbound) {
      events.push({ kind: 'script.skipped', asset_ref: b.ref, reason: 'unbound_scope', scope: b.scope });
    }

    for (const b of runnable) {
      const source = await artifacts.script(head.hash, b.ref);
      if (source === null) {
        // The binding names a script the tree does not carry — a compiler defect, loud.
        events.push({ kind: 'script.failed', asset_ref: b.ref, hook: 'onPageSubmit', reason: 'missing' });
        log.error('script_missing', { artifact_hash: head.hash, asset_ref: b.ref });
        continue;
      }

      const vars = session.vars as Record<string, unknown>;
      const result = await host.run({
        source,
        assetRef: b.ref,
        seed: session.random_seed,
        context: {
          session_id: session.session_id, // opaque; NOT respondent_id (E §13.1)
          survey_version: session.survey_version_id,
          language: session.language,
          device: session.device.class,
          country: session.geo.country,
          page_id: pageId,
          hook: 'onPageSubmit',
          is_test: session.is_test,
          server_time_ms: session.server_time_ms,
        },
        // Reads see earlier scripts' committed writes: declared order is execution order
        // (E §5 step 6), and a chain where script 2 cannot read script 1's output is a chain
        // in name only.
        getValue: ref => {
          const id = idOf(ref);
          if (id === undefined) return undefined;
          return id in writes ? writes[id] : vars[id];
        },
        varKind: ref => byRef.get(ref)?.kind,
        wasShown: ref => {
          const id = idOf(ref);
          if (id === undefined) return false;
          const prov = (session.var_provenance as Record<string, { p?: string }>)[id];
          return prov?.p === 'respondent';
        },
      });

      if (!result.ok) {
        // FAIL-OPEN: the interview continues without this script's effects (E §13.3 step 4).
        events.push({
          kind: 'script.failed', asset_ref: b.ref, hook: 'onPageSubmit',
          reason: result.reason, wall_ms: result.wall_ms, interrupts: result.interrupts,
          // The stack/message reaches the event only in test mode (E §13.3 step 3): a
          // production event log readable by survey staff must not carry whatever a customer
          // script put in an error string.
          ...(session.is_test ? { error: result.error } : {}),
        });
        log.warn('script_failed', {
          session_id: session.session_id, asset_ref: b.ref,
          reason: result.reason, wall_ms: result.wall_ms,
        });
        continue;
      }

      for (const [ref, value] of Object.entries(result.writes)) {
        const id = idOf(ref);
        if (id === undefined) continue; // the host already refused unknown refs; belt+braces
        writes[id] = value;
        write_provenance[id] = b.ref;
      }
      for (const f of result.flags) if (!flags.includes(f)) flags.push(f);
      terminate ??= result.terminate;
      reject ??= result.reject;
      events.push({
        kind: 'script.executed', asset_ref: b.ref, hook: 'onPageSubmit',
        wall_ms: result.wall_ms, interrupts: result.interrupts,
        writes: Object.keys(result.writes).length,
        ...(result.logs.length > 0 && session.is_test ? { logs: result.logs } : {}),
      });
    }

    return { writes, write_provenance, flags, terminate, reject, events };
  };
}
