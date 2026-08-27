/**
 * Session vars → the engine's tagged `Value`s.
 *
 * THE DEFECT THIS FIXES, stated plainly because it shipped and nothing caught it. A session's
 * `vars` are raw JSON — `{ var_age: 34, var_q5: [1, 3] }` — because that is what the codecs
 * write and what `runtime.response_documents.vars` holds. `packages/logic` reads
 * `Value`s — `{ k: 'num', v: 34 }`, `{ k: 'set', v: [1,3], d: 'dom_q5' }` — and its
 * `varStateOf` takes a map of them. The runtime handed the raw map straight in, so every
 * comparison a respondent's answer participates in saw a value of the wrong shape:
 * `AGE == 34` was FALSE for a respondent who answered 34, and an ordering comparison raised
 * `LogicInvariant`. Display rules, screeners, terminations — all of them, quietly wrong.
 *
 * `packages/logic/src/raw-vars.probe.test.ts` is the probe that pins the engine's side of this.
 *
 * WHY THE CONVERSION LIVES HERE rather than inside `varStateOf`. The tag needs three facts the
 * engine does not have and must not acquire: the variable's declared TYPE (the manifest's), the
 * DOMAIN id an enum or set belongs to (derived from the owning question — `dom_<question id>`,
 * the convention `emit/logic.ts` writes and `EvalSchema.ownerQuestion` inverts), and the
 * knowledge that a raw `null` is `{k:'null'}` and not a missing key. Putting it in `varStateOf`
 * would either duplicate the manifest inside `packages/logic` (which imports nothing — ADR-010)
 * or make the engine guess a type from a JavaScript runtime type, and guessing is how a `1`
 * meant as an enum code becomes a number that compares equal to a different question's `1`.
 *
 * WHY IT IS NOT LENIENT. A value whose raw shape contradicts its declared type becomes
 * `{k:'null'}` — not a coerced best guess. Coercion here would mean a text `"34"` from a
 * tampered payload comparing equal to the number 34 in a screener, which is the anti-tamper
 * boundary (E §5 step 3) being undone one layer later by a helper trying to be kind. The filter
 * already rejected what does not belong; anything still mistyped is a bug, and `null` is the
 * value that makes a rule UNKNOWN rather than accidentally TRUE.
 */

import type { ArtifactManifest } from '@resscript/schema';

/** The engine's `Value`, restated structurally so this module imports no engine types. */
export type TaggedValue =
  | { readonly k: 'null' }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'date'; readonly v: string }
  | { readonly k: 'enum'; readonly v: number; readonly d: string }
  | { readonly k: 'set'; readonly v: readonly number[]; readonly d: string }
  | { readonly k: 'obj'; readonly v: { readonly [key: string]: TaggedValue } };

const NULL: TaggedValue = { k: 'null' };

/**
 * `variable id → domain id`, for the enum-typed and set-typed variables.
 *
 * The domain id is `dom_<owning question id>` where a question owns the variable, and
 * `dom_<variable id>` otherwise — the two branches `emit/logic.ts` writes when it builds
 * `label_keys`, restated here rather than re-derived differently.
 *
 * The owner comes from the ENGINE's own inverse (`EvalSchema.ownerQuestion`), passed in, rather
 * than from a second inversion of `question_variables` built here. That is deliberate: the
 * artifact's forward map is the stored fact and the engine already derives the inverse on read
 * ("so the two cannot disagree" — `ArtifactLogicSchema`'s own comment). A third derivation is a
 * third thing that can disagree, and a wrong domain id makes an enum compare unequal to itself.
 */
export function domainIdFor(
  variableId: string,
  ownerQuestion?: (variableId: string) => string | undefined,
): string {
  return `dom_${ownerQuestion?.(variableId) ?? variableId}`;
}

/** One raw value, tagged per its declared type. Mismatches become `null` — see the header. */
export function tagValue(
  raw: unknown,
  type: string,
  domainFor: () => string,
): TaggedValue {
  if (raw === null || raw === undefined) return NULL;
  switch (type) {
    case 'boolean':
      return typeof raw === 'boolean' ? { k: 'bool', v: raw } : NULL;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? { k: 'num', v: raw } : NULL;
    case 'text':
      return typeof raw === 'string' ? { k: 'text', v: raw } : NULL;
    case 'date':
      return typeof raw === 'string' ? { k: 'date', v: raw } : NULL;
    case 'enum':
      // Codes are numbers in the engine's model (`value.ts`: `enum` carries `v: number`), and a
      // string code is what a form-encoded submit produces BEFORE the codec coerces it. Reaching
      // here as a string means the codec did not run, which is a bug worth a null rather than a
      // parse that hides it.
      return typeof raw === 'number' ? { k: 'enum', v: raw, d: domainFor() } : NULL;
    case 'set': {
      if (!Array.isArray(raw)) return NULL;
      const codes: number[] = [];
      for (const entry of raw) {
        if (typeof entry !== 'number') return NULL; // one bad member invalidates the set
        codes.push(entry);
      }
      // Sorted and deduped: schema §1's set model is order-free, and the engine's `strictEq`
      // compares sets member by member, so two spellings of one set must not differ.
      const unique = [...new Set(codes)].sort((a, b) => a - b);
      return { k: 'set', v: unique, d: domainFor() };
    }
    case 'object':
      // An object variable's members are themselves values, and nothing in Phase 1 declares one
      // (F §4's non-scalar types project to scalars). Tagged as an empty object rather than
      // walked, with the shape recorded so a future member-typed walk has somewhere to land.
      return typeof raw === 'object' && !Array.isArray(raw) ? { k: 'obj', v: {} } : NULL;
    default:
      return NULL;
  }
}

/**
 * The whole session's vars, tagged. Variables absent from the manifest are DROPPED rather than
 * guessed: the manifest is the closed world of writable names (the anti-tamper filter reads the
 * same list), so a var with no entry is either a stale key from an older artifact or something
 * that should never have been stored, and handing the engine an untyped value is how one of
 * those becomes a rule verdict.
 */
export function tagVars(
  vars: Readonly<Record<string, unknown>>,
  manifest: Pick<ArtifactManifest, 'variable_manifest'>,
  ownerQuestion?: (variableId: string) => string | undefined,
): Record<string, TaggedValue> {
  const out: Record<string, TaggedValue> = {};
  for (const entry of manifest.variable_manifest) {
    const raw = vars[entry.id];
    if (raw === undefined) continue; // absent, not null: the engine reads a missing key as NULL
    out[entry.id] = tagValue(raw, entry.type, () => domainIdFor(entry.id, ownerQuestion));
  }
  return out;
}
