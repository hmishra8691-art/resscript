/**
 * The registry the parser, the resolver and the printer read.
 *
 * D §3.2 is emphatic that the checker is parameterized by the variable registry "and nothing
 * else", and it names `byRef` as existing solely for this package: "used only by the parser to
 * resolve refs". So the type environment is the substrate here too — this file adds exactly one
 * thing to it, and only because the DSL needs something logic does not have.
 *
 * ## The gap: page and block refs
 *
 * `TypeEnv` can resolve a question ref (`QuestionDecl.ref`) and a variable ref (`VarDecl.name`).
 * It cannot resolve a page or block ref, because `PageDecl` is `{ id, block_id?, question_ids }`
 * and `BlockDecl` is `{ id, page_ids }` — neither carries a `ref`. But the grammar needs them:
 * `SKIP TO P7`, `SHOW PAGE P3`, `RANDOMIZE BLOCK MAIN SUBSET 2 EVENLY` (D §6.3) are all in the
 * P1-07 surface.
 *
 * Two options, and the choice matters. Adding `ref` to logic's `PageDecl`/`BlockDecl` would put a
 * field in the engine's type environment that the engine never reads — the checker has no use for
 * a page's human name — and `packages/logic` is the one package whose surface must stay minimal
 * (ADR-004: it ships to every respondent and runs inside QuickJS). So instead the DSL declares an
 * optional `NodeIndex`, which the caller with the content tree (`packages/compiler`, P1-08; the
 * studio, which has the tree loaded anyway) supplies. Absent it, page and block refs parse, are
 * preserved verbatim, and produce an `RSL-0012` **warning** rather than an error.
 *
 * Reported as a gap in the source documents rather than patched by widening logic's registry.
 */

import type { BlockId, LogicRegistryInput, PageId, QuestionId, TypeEnv } from '@resscript/logic';
import { buildTypeEnv } from '@resscript/logic';

/**
 * Ref ↔ id for the content nodes logic's registry does not name.
 *
 * Questions are included so a caller that already has the tree can serve all three from one place;
 * when a member is absent the resolver falls back to the type environment (which knows questions).
 */
export interface NodeIndex {
  readonly questionByRef?: (ref: string) => QuestionId | undefined;
  readonly pageByRef?: (ref: string) => PageId | undefined;
  readonly blockByRef?: (ref: string) => BlockId | undefined;
  readonly refOfQuestion?: (id: QuestionId) => string | undefined;
  readonly refOfPage?: (id: PageId) => string | undefined;
  readonly refOfBlock?: (id: BlockId) => string | undefined;
}

export interface DslRegistry {
  readonly env: TypeEnv;
  readonly nodes?: NodeIndex;
}

export function dslRegistry(input: LogicRegistryInput, nodes?: NodeIndex): DslRegistry {
  const env = buildTypeEnv(input);
  return nodes === undefined ? { env } : { env, nodes };
}

export function fromTypeEnv(env: TypeEnv, nodes?: NodeIndex): DslRegistry {
  return nodes === undefined ? { env } : { env, nodes };
}

/** The question id a ref names, from the node index if supplied, else from the type environment. */
export function questionIdOf(registry: DslRegistry, ref: string): QuestionId | undefined {
  const fromIndex = registry.nodes?.questionByRef?.(ref);
  if (fromIndex !== undefined) return fromIndex;
  for (const question of registry.env.questions()) {
    if (question.ref === ref) return question.id;
  }
  return undefined;
}

/**
 * The *current* ref of a question id — the rename story (schema §3).
 *
 * The printer calls this rather than the ref the author typed, so a rule printed after a rename
 * reads with the new name and no find-and-replace ever happened. When the id cannot be resolved
 * (a deleted question, or a registry that predates it) the caller's stored text is used instead:
 * printing an id would be unreadable, and printing nothing would silently delete the target.
 */
export function refOfQuestion(registry: DslRegistry, id: QuestionId): string | undefined {
  const fromIndex = registry.nodes?.refOfQuestion?.(id);
  if (fromIndex !== undefined) return fromIndex;
  return registry.env.question(id)?.ref;
}

export function refOfPage(registry: DslRegistry, id: PageId): string | undefined {
  return registry.nodes?.refOfPage?.(id);
}

export function refOfBlock(registry: DslRegistry, id: BlockId): string | undefined {
  return registry.nodes?.refOfBlock?.(id);
}
