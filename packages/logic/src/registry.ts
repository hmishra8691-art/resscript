/**
 * The type environment — D §3.2: "the checker is parameterized by the registry from schema
 * §4 — nothing else."
 *
 * The declarations here are a *projection* of `packages/schema`'s `Variable`, `QuestionNode`
 * and friends, restated because this package cannot import schema (see ids.ts for why).
 * The projection is narrow on purpose: it carries exactly what the checker, the evaluator and
 * the analyses read. Anything schema owns and logic does not need (labels, media, export
 * columns, randomization specs) is deliberately absent, so a schema change that does not
 * affect typing cannot ripple into here.
 *
 * `packages/compiler` (P1-08) builds a `LogicRegistryInput` from a `Survey`. That adapter is
 * the single translation point, and it is where the branded-id casts happen.
 */

import type { Expr, GroupItem, Group, Type } from './ast.js';
import { T_BOOL, T_DATE, T_NEVER, T_NUM, T_TEXT } from './ast.js';
import type {
  BlockId,
  DomainId,
  OptionId,
  PageId,
  QuestionId,
  VariableId,
} from './ids.js';

/** schema `VARIABLE_KINDS`, restated. */
export const VARIABLE_KINDS = ['response', 'hidden', 'derived', 'system', 'quota', 'design'] as const;
export type VariableKind = (typeof VARIABLE_KINDS)[number];

/** schema `VARIABLE_TYPES`, restated. */
export const VARIABLE_TYPES = ['enum', 'boolean', 'number', 'text', 'date', 'set', 'object'] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

/**
 * Which part of a question produced the variable. A flattening of schema's `VariablePart`
 * discriminated union down to its tag plus the two fields logic reads (`code`, `option_id`),
 * because the engine's only questions are "which item is this" and "what code does it carry".
 */
export type VariablePartKind =
  | 'scalar'
  | 'option'
  | 'row'
  | 'column'
  | 'cell'
  | 'other_specify'
  | 'set_view'
  | 'suffix'
  | 'design_task';

export interface VarDecl {
  readonly id: VariableId;
  /** The derived name (`Q2r3`). Used by `byRef`, by diagnostics and by the trace. */
  readonly name: string;
  readonly kind: VariableKind;
  readonly type: VariableType;
  /** Required when `type` is `enum` or `set`. */
  readonly domain?: DomainId;
  /** Present exactly when `kind === 'derived'`. */
  readonly expression?: Expr;
  readonly persist: boolean;
  readonly pii: boolean;
  readonly question_id?: QuestionId;
  readonly part?: VariablePartKind;
  /** The item code for an `option`/`row`/`column` fan-out member. */
  readonly code?: number;
  readonly option_id?: OptionId;
  /** 1-based loop iteration (schema §13), when the variable lives inside a loop. */
  readonly iteration?: number;
  /** Field types for `type: 'object'` variables. */
  readonly fields?: { readonly [key: string]: Type };
}

export interface EnumEntry {
  readonly code: number;
  readonly label_key: string;
}

export interface EnumDomain {
  readonly id: DomainId;
  readonly entries: readonly EnumEntry[];
  /**
   * D §3.3 requires this to reject `<` on a nominal domain — the "top-2-box on a brand list"
   * bug. D §11 note 2 records that schema §4's `enum_domain` has no `ordinal` flag; re-checked
   * against the current `packages/schema/src/types/variables.ts` and it is **still missing**
   * (`EnumDomainEntry` is `{ code, label_key }` and `Variable.enum_domain` is a bare array).
   * So the flag lives here, defaulted by `buildTypeEnv` to `false` — nominal — because the
   * unsound direction (assuming a brand list is a scale) is the one that ships the bug.
   */
  readonly ordinal: boolean;
}

export interface ItemDecl {
  readonly option_id: OptionId;
  readonly code: number;
  readonly label_key: string;
  /** 0-based canonical position; display order comes from `EvalContext.orders`. */
  readonly position: number;
  /** The author's handle for the item, used to resolve `Group.column_ref` / `row_ref`. */
  readonly ref?: string;
  /** "Always show": a mask may not remove this item. See `applyMask`. */
  readonly pin?: boolean;
  readonly meta?: { readonly [key: string]: string | number | boolean | null };
  /** The fan-out variable this item emits, when it emits one. */
  readonly variable_id?: VariableId;
}

export interface QuestionDecl {
  readonly id: QuestionId;
  readonly ref: string;
  readonly page_id?: PageId;
  readonly required: boolean;
  readonly options: readonly ItemDecl[];
  readonly rows: readonly ItemDecl[];
  readonly columns: readonly ItemDecl[];
  /** The domain the question's option codes belong to. */
  readonly domain?: DomainId;
  /** Every variable the question emits, in declaration order. */
  readonly emits: readonly VariableId[];
}

export interface PageDecl {
  readonly id: PageId;
  readonly block_id?: BlockId;
  readonly question_ids: readonly QuestionId[];
}

export interface BlockDecl {
  readonly id: BlockId;
  readonly page_ids: readonly PageId[];
}

export interface LogicRegistryInput {
  readonly variables: readonly VarDecl[];
  readonly domains: readonly EnumDomain[];
  readonly questions?: readonly QuestionDecl[];
  readonly pages?: readonly PageDecl[];
  readonly blocks?: readonly BlockDecl[];
}

export interface TypeEnv {
  readonly byId: (id: VariableId) => VarDecl | undefined;
  /** Used only by the parser (P1-07) to resolve a source-level `ref` to an id. */
  readonly byRef: (ref: string) => VarDecl | undefined;
  readonly domain: (d: DomainId) => EnumDomain | undefined;
  readonly question: (id: QuestionId) => QuestionDecl | undefined;
  readonly page: (id: PageId) => PageDecl | undefined;
  readonly block: (id: BlockId) => BlockDecl | undefined;
  /** Resolves `question_emits` / `matrix_rows` / `options` / … to a concrete ordered list. */
  readonly groupItems: (g: Group) => readonly GroupItem[];
  readonly variables: () => readonly VarDecl[];
  readonly questions: () => readonly QuestionDecl[];
  readonly pages: () => readonly PageDecl[];
  /** The static type of a declaration. `never` when the declaration is itself malformed. */
  readonly typeOf: (decl: VarDecl) => Type;
  /** The question a variable belongs to, if any — the reverse of `QuestionDecl.emits`. */
  readonly ownerQuestion: (id: VariableId) => QuestionDecl | undefined;
}

export function buildTypeEnv(input: LogicRegistryInput): TypeEnv {
  const byId = new Map<VariableId, VarDecl>();
  const byRef = new Map<string, VarDecl>();
  for (const decl of input.variables) {
    byId.set(decl.id, decl);
    // First declaration wins on a duplicate name. Duplicate names are schema's error
    // (SCH-1001), not ours — silently overwriting would make the checker's diagnostics
    // depend on registry order, which is worse than deterministically preferring the first.
    if (!byRef.has(decl.name)) byRef.set(decl.name, decl);
  }

  const domains = new Map<DomainId, EnumDomain>();
  for (const d of input.domains) domains.set(d.id, d);

  const questions = new Map<QuestionId, QuestionDecl>();
  for (const q of input.questions ?? []) questions.set(q.id, q);

  const pages = new Map<PageId, PageDecl>();
  for (const p of input.pages ?? []) pages.set(p.id, p);

  const blocks = new Map<BlockId, BlockDecl>();
  for (const b of input.blocks ?? []) blocks.set(b.id, b);

  const owner = new Map<VariableId, QuestionDecl>();
  for (const q of questions.values()) {
    for (const variableId of q.emits) owner.set(variableId, q);
  }

  const typeOf = (decl: VarDecl): Type => {
    switch (decl.type) {
      case 'boolean':
        return T_BOOL;
      case 'number':
        return T_NUM;
      case 'text':
        return T_TEXT;
      case 'date':
        return T_DATE;
      case 'enum':
        return decl.domain === undefined ? T_NEVER : { k: 'enum', d: decl.domain };
      case 'set':
        return decl.domain === undefined ? T_NEVER : { k: 'set', d: decl.domain };
      case 'object':
        return { k: 'obj', fields: decl.fields ?? {} };
      default: {
        const never: never = decl.type;
        // A declaration this package does not understand is `never`, not a crash: the checker
        // reports it (LGC-T001) and suppresses the cascade.
        void never;
        return T_NEVER;
      }
    }
  };

  /**
   * A resolved group member, enriched from the question's item declarations.
   *
   * The enrichment is not cosmetic: `item.label` and `item.meta.<key>` inside an `agg.where`
   * read `label_key` and `meta`, and a `VarDecl` carries neither — a variable knows its code,
   * not its label. Resolving them here, at compile time, is what keeps the evaluator free of
   * registry lookups (D §10.1).
   */
  const itemFor = (decl: VarDecl, position: number): GroupItem => {
    const question = decl.question_id === undefined ? undefined : questions.get(decl.question_id);
    const item = question === undefined ? undefined : findItem(question, decl);
    return {
      variable_id: decl.id,
      ...(decl.option_id !== undefined ? { option_id: decl.option_id } : {}),
      ...(decl.code !== undefined ? { code: decl.code } : {}),
      ...(question?.domain !== undefined ? { domain: question.domain } : {}),
      ...(item?.label_key !== undefined ? { label_key: item.label_key } : {}),
      ...(item?.meta !== undefined ? { meta: item.meta } : {}),
      position,
    };
  };

  const emittedBy = (questionId: QuestionId): readonly VarDecl[] => {
    const q = questions.get(questionId);
    if (q !== undefined) {
      const out: VarDecl[] = [];
      for (const id of q.emits) {
        const decl = byId.get(id);
        if (decl !== undefined) out.push(decl);
      }
      if (out.length > 0) return out;
    }
    // Fall back to a scan when the question registry was not supplied (the checker can run
    // on variables alone, which is what the studio's editor path does before a full compile).
    return input.variables.filter((v) => v.question_id === questionId);
  };

  const groupItems = (g: Group): readonly GroupItem[] => {
    switch (g.kind) {
      case 'explicit': {
        const out: GroupItem[] = [];
        g.variable_ids.forEach((id, index) => {
          const decl = byId.get(id);
          out.push(decl === undefined ? { variable_id: id, position: index } : itemFor(decl, index));
        });
        return out;
      }
      case 'question_emits': {
        // `set_view` is excluded: it is the derived `set<enum>` *view* over the fan-out
        // (schema §1), not a member of it. Including it would make COUNT(Q5) count the
        // question's own summary variable as one more item — off-by-one in every multi-select
        // count, and exactly the kind of bug that only shows up in a client's tab.
        const members = emittedBy(g.question_id).filter((v) => v.part !== 'set_view');
        return members.map((decl, index) => itemFor(decl, index));
      }
      case 'matrix_rows': {
        const members = emittedBy(g.question_id).filter((v) => {
          if (g.column_ref === undefined) return v.part === 'row';
          if (v.part !== 'cell') return false;
          const q = questions.get(g.question_id);
          const column = q?.columns.find((c) => c.ref === g.column_ref);
          return column !== undefined && v.code === column.code;
        });
        return members.map((decl, index) => itemFor(decl, index));
      }
      case 'matrix_cols': {
        const members = emittedBy(g.question_id).filter((v) => {
          if (g.row_ref === undefined) return v.part === 'column';
          if (v.part !== 'cell') return false;
          const q = questions.get(g.question_id);
          const row = q?.rows.find((r) => r.ref === g.row_ref);
          return row !== undefined && v.code === row.code;
        });
        return members.map((decl, index) => itemFor(decl, index));
      }
      case 'loop_iterations': {
        // Loop iterations are unrolled by the compiler into concrete variables (schema §13),
        // capped by `max_iterations`, which is what keeps `agg` bounded (D §2.4).
        const members = emittedBy(g.loop_id)
          .filter((v) => v.iteration !== undefined && v.question_id === g.question_id)
          .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
        return members.map((decl, index) => itemFor(decl, index));
      }
      case 'options': {
        const q = questions.get(g.question_id);
        if (q === undefined) return [];
        return q.options.map((item) => ({
          ...(item.variable_id !== undefined ? { variable_id: item.variable_id } : {}),
          option_id: item.option_id,
          code: item.code,
          ...(q.domain !== undefined ? { domain: q.domain } : {}),
          label_key: item.label_key,
          position: item.position,
          ...(item.meta !== undefined ? { meta: item.meta } : {}),
        }));
      }
      default: {
        const never: never = g;
        void never;
        return [];
      }
    }
  };

  return {
    byId: (id) => byId.get(id),
    byRef: (ref) => byRef.get(ref),
    domain: (d) => domains.get(d),
    question: (id) => questions.get(id),
    page: (id) => pages.get(id),
    block: (id) => blocks.get(id),
    groupItems,
    variables: () => input.variables,
    questions: () => input.questions ?? [],
    pages: () => input.pages ?? [],
    typeOf,
    ownerQuestion: (id) => owner.get(id),
  };
}

/** Writable variable kinds for `set_variable` (D §3.5, LGC-T030). */
export const WRITABLE_VARIABLE_KINDS: readonly VariableKind[] = [
  'hidden',
  'derived',
  'quota',
  'design',
];

export function isWritableKind(kind: VariableKind): boolean {
  return WRITABLE_VARIABLE_KINDS.includes(kind);
}

/** The item declaration a fan-out variable came from: by option id when it has one, else code. */
function findItem(question: QuestionDecl, decl: VarDecl): ItemDecl | undefined {
  const axes: readonly (readonly ItemDecl[])[] = [question.options, question.rows, question.columns];
  for (const axis of axes) {
    for (const item of axis) {
      if (decl.option_id !== undefined && item.option_id === decl.option_id) return item;
      if (decl.option_id === undefined && decl.code !== undefined && item.code === decl.code) return item;
    }
  }
  return undefined;
}
