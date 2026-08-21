/**
 * `CMP-0600`: the survey needs a plan feature the org does not have — and the entitlement list the
 * artifact manifest records (`01-system-architecture.md` §5, C §2's `entitlement_reqs`, roadmap
 * P1-08).
 *
 * ## `undefined` and `new Set()` are different, and the difference is load-bearing
 *
 * `CompileInput.entitlements` is `ReadonlySet<string> | undefined`, and the two absent-looking
 * values mean opposite things:
 *
 *  - **`undefined` — do not check.** There is no plan in scope. A fixture, a unit test, a
 *    self-hosted deployment, a CLI compile of a document nobody has an org for. Reporting
 *    `CMP-0600` here would make every test that uses a `conjoint` question fail for a reason that
 *    has nothing to do with what it is testing, and would make a self-hosted install unable to
 *    publish anything at all.
 *  - **`new Set()` — the plan grants nothing.** There *is* a plan in scope and it is empty, which is
 *    a real state (a free tier, a suspended org). Every requirement is unmet and every requirement
 *    is reported.
 *
 * `types.ts`' own comment on the field says "An empty set means 'check nothing', not 'deny
 * everything'", which reads the other way round. That comment describes the *intent* of the
 * optional field and the code implements the distinction the milestone brief asks for; the wording
 * is noted in the report rather than edited, since `types.ts` is a contract file. The behaviour here
 * is: `undefined` checks nothing, empty denies everything.
 *
 * ## Where a requirement comes from
 *
 * Two sources, and both are enforced, because either alone is bypassable. `survey.entitlement_reqs`
 * is the *stored* list, which is what an API caller sees and can therefore edit; a plugin's
 * `meta.entitlementKey` is the *derived* one, and `PluginMeta` says exactly why it matters: "The
 * compiler copies this into `survey.entitlement_reqs`, which is the enforcement that matters — a
 * user cannot route around it by calling the API directly." A survey whose stored list was stripped
 * still fails on the plugin's key, and `collectEntitlements` re-derives the union so the artifact
 * records what was actually required rather than what the document claimed.
 *
 * One diagnostic per missing *key*, not per question: twelve conjoint questions on a plan without
 * conjoint is one purchase decision, and twelve rows would bury the eleven other things wrong with
 * the survey. `detail` names the sources, capped.
 */

import { pointer, type JsonValue, type Survey } from '@resscript/schema';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';

/** How many source ids one diagnostic lists. */
const MAX_LISTED_SOURCES = 12;

/**
 * What this pass needs from `resolvePlugins`, stated as the narrow thing rather than the whole
 * resolution: this check does not care about plugin keys or versions, and depending on them would
 * make it impossible to run without a registry.
 */
export interface PluginEntitlementIndex {
  /** Question id → the entitlement key its resolved plugin requires. */
  readonly entitlementKeys: ReadonlyMap<string, string>;
}

export interface EntitlementsInput {
  readonly survey: Survey;
  /**
   * The org's plan features. **`undefined` = do not check**; an empty set = the plan grants
   * nothing. See the header.
   */
  readonly entitlements?: ReadonlySet<string> | undefined;
  readonly plugins: PluginEntitlementIndex;
}

interface Requirement {
  readonly key: string;
  /** `entitlement_reqs` index, or a question id. For `detail`, and for the pointer. */
  readonly path: string;
  readonly source: string;
  readonly sourceId: string;
}

function requirementsOf(input: EntitlementsInput): readonly Requirement[] {
  const out: Requirement[] = [];
  (input.survey.entitlement_reqs ?? []).forEach((key, index) => {
    if (key === '') return;
    out.push({
      key,
      path: pointer('entitlement_reqs', index),
      source: 'entitlement_reqs',
      sourceId: String(index),
    });
  });
  // Sorted by question id so the diagnostic array does not move when content is reordered — the
  // pointer is derived from the id, not from a tree position, for the same reason.
  //
  // The pointer is `/entitlement_reqs` rather than the question, deliberately: the author's two
  // fixes are "buy the feature" and "delete the question", and the first is what the field is.
  // The question ids are in `detail.sources`, which is what a UI would link.
  for (const questionId of [...input.plugins.entitlementKeys.keys()].sort()) {
    const key = input.plugins.entitlementKeys.get(questionId);
    if (key === undefined || key === '') continue;
    out.push({
      key,
      path: pointer('entitlement_reqs'),
      source: 'plugin',
      sourceId: questionId,
    });
  }
  return out;
}

export function analyzeEntitlements(input: EntitlementsInput): readonly CompileDiagnostic[] {
  const granted = input.entitlements;
  // Not `granted === undefined || granted.size === 0`. See the header: the two are different.
  if (granted === undefined) return [];

  const missing = new Map<string, Requirement[]>();
  for (const requirement of requirementsOf(input)) {
    if (granted.has(requirement.key)) continue;
    const existing = missing.get(requirement.key);
    if (existing === undefined) missing.set(requirement.key, [requirement]);
    else existing.push(requirement);
  }

  const out: CompileDiagnostic[] = [];
  for (const key of [...missing.keys()].sort()) {
    const sources = missing.get(key) ?? [];
    const first = sources[0];
    const detail: { readonly [k: string]: JsonValue } = {
      entitlement_key: key,
      granted_count: granted.size,
      source_count: sources.length,
      sources: sources.slice(0, MAX_LISTED_SOURCES).map((requirement) => ({
        source: requirement.source,
        source_id: requirement.sourceId,
      })),
      truncated: sources.length > MAX_LISTED_SOURCES,
    };
    out.push(
      cmpDiagnostic(
        'CMP-0600',
        `This survey requires the entitlement ${JSON.stringify(key)}, which the org's plan does ` +
          `not include (it grants ${String(granted.size)} feature(s)). Publishing would put a ` +
          'survey in field that the plan cannot support, so the check is here rather than at the ' +
          'first respondent.',
        first?.path ?? pointer('entitlement_reqs'),
        detail,
      ),
    );
  }

  return sortCompileDiagnostics(out);
}

/**
 * Every entitlement this survey actually requires, deduped and sorted — `ArtifactManifest.
 * entitlements`.
 *
 * The union of the stored list and every resolved plugin's key, because the manifest is what a
 * later reader (an audit, a plan downgrade, a support question about why a survey stopped
 * rendering) consults, and "what the document claimed" is the weaker of the two facts. Sorted
 * because these bytes are hashed into the artifact id, and a set's iteration order is insertion
 * order — which for the plugin half is resolution order.
 */
export function collectEntitlements(
  survey: Survey,
  plugins: PluginEntitlementIndex,
): readonly string[] {
  const out = new Set<string>();
  for (const key of survey.entitlement_reqs ?? []) {
    if (key !== '') out.add(key);
  }
  for (const key of plugins.entitlementKeys.values()) {
    if (key !== '') out.add(key);
  }
  return [...out].sort();
}
