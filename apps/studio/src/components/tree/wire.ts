/**
 * The tree editor's wire types — API §2.5, declared HERE rather than in `lib/api-types.ts`.
 *
 * `lib/api-types.ts` is the right long-term home and it already carries a narrow `TreeNodeView`
 * (the summary projection P1-12's target picker reads). It is being edited by the agent
 * implementing the §2.5 routes in the same session as this component, so a second author in that
 * file would be a merge conflict on every save. The types below therefore live beside their only
 * consumer, and the follow-up is one move: delete this file's interfaces, re-export from
 * `api-types.ts`, keep the normalizers.
 *
 * ## Why every field but the structural four is optional
 *
 * The routes are being written right now, and the difference between `{data: […]}` and a bare
 * array — or between `emits` and `variables`, or `kind` and `node_kind` — is the kind of detail
 * that gets settled in the last hour of a route's implementation. A component that hard-codes one
 * spelling fails on the other with a blank pane and no message. So the shapes are permissive and
 * the *normalizers* below are the single place that knows the spellings: when the routes land, a
 * mismatch is a two-line fix in one file rather than a hunt through five components.
 *
 * What is NOT defensive: `id`, `kind`, `parent_id`, `sort_key`. Those four are the tree's
 * identity and order, they are in every version of the contract, and a row missing one of them is
 * a bug we want to see rather than paper over.
 */

/**
 * `content.node_kind` (DB §4.1). Restated locally for the same reason as the rest of this file;
 * `packages/schema` exports the id *prefixes* for these kinds but no kind union, and
 * `api-types.ts`'s `TreeNodeView.kind` spells it exactly this way.
 */
export type NodeKind = 'block' | 'page' | 'question' | 'text';

export type ItemKind = 'option' | 'row' | 'column';

/**
 * One `rule_summaries[]` entry — the rule INDEX, not the rule body (UI §3.3).
 *
 * `src` is the printed ResScript condition §3.1 wants under the node ("the printer is the
 * renderer"). The route serves `kind` and `action` today and not `src`, so the annotation renders
 * what it has: the effect, and the printed condition the moment the field appears.
 */
export interface RuleSummaryWire {
  readonly id?: string;
  readonly kind?: string;
  readonly action?: string | null;
  readonly effect?: string;
  readonly src?: string;
  readonly evaluation?: string;
  readonly authored_in?: string;
  readonly severity?: 'error' | 'warning' | 'info';
}

/** `GET /versions/{id}/tree?fields=summary&include=rules,badges` — one row per node. */
export interface TreeRowWire {
  readonly id: string;
  readonly kind: NodeKind;
  readonly parent_id: string | null;
  readonly sort_key: string;
  readonly ref?: string | null;
  readonly label_preview?: string | null;
  readonly question_type?: string | null;
  readonly required?: boolean | null;
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly rule_summaries?: readonly RuleSummaryWire[];
  readonly diagnostic_counts?: { readonly errors?: number; readonly warnings?: number };
  readonly item_count?: number;
  /** Soft delete (DB §4.1). Present only when the caller asked for deleted rows. */
  readonly deleted_at?: string | null;
}

/** One `content.items` row. `code` and `position` are SEPARATE fields — schema §5.1. */
export interface ItemWire {
  readonly id: string;
  readonly item_kind?: ItemKind;
  readonly ref?: string | null;
  readonly code: number;
  readonly label?: string | null;
  readonly label_preview?: string | null;
  readonly position?: number;
  readonly sort_key?: string;
  readonly exclusive?: boolean;
  readonly anchor?: string | null;
  readonly value_override?: string | null;
  readonly deleted_at?: string | null;
}

/** One variable a question emits, as the node body and `variables_created` report it. */
export interface EmittedVariableWire {
  readonly id?: string;
  readonly name: string;
  readonly kind?: string;
  readonly vtype?: string;
  readonly type?: string;
  readonly export_column?: string | null;
  readonly export?: { readonly column?: string | null; readonly include?: boolean } | null;
  readonly pii?: boolean;
}

/**
 * `GET /nodes/{id}?include=items,…` — the lazily-fetched body.
 *
 * Read and write field names differ, and that is the API's own asymmetry rather than a defensive
 * guess: the row carries `label_key` / `title_key` / `instruction_key` (a node names a translation;
 * it does not hold copy), while the write schema takes `label`, `title` and `instruction`. So the
 * normalizer reads the `_key` spellings and `NodeInspector` writes the bare ones.
 */
export interface NodeBodyWire {
  readonly id: string;
  readonly kind?: NodeKind;
  readonly node_kind?: NodeKind;
  readonly parent_id?: string | null;
  readonly sort_key?: string;
  readonly ref?: string | null;
  readonly label?: string | null;
  readonly label_key?: string | null;
  readonly title_key?: string | null;
  readonly instruction?: string | null;
  readonly instruction_key?: string | null;
  readonly question_type?: string | null;
  readonly required?: boolean | null;
  readonly config?: Readonly<Record<string, unknown>> | null;
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly items?: readonly ItemWire[];
  readonly options?: readonly ItemWire[];
  readonly emits?: readonly EmittedVariableWire[];
  readonly variables?: readonly EmittedVariableWire[];
  readonly deleted_at?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Normalized shapes — what the components actually render                    */
/* -------------------------------------------------------------------------- */

export interface EmittedVariable {
  readonly name: string;
  readonly kind: string;
  readonly vtype: string;
  readonly exportColumn: string | null;
  readonly pii: boolean;
}

export interface NodeBody {
  readonly id: string;
  readonly kind: NodeKind;
  readonly ref: string | null;
  readonly label: string | null;
  readonly instruction: string | null;
  readonly questionType: string | null;
  readonly required: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly items: readonly ItemWire[];
  readonly emits: readonly EmittedVariable[];
  readonly deletedAt: string | null;
}

/** `[…]`, `{data:[…]}` and `{items:[…]}` all mean the same thing to a renderer. */
export function rowsOf<T>(payload: unknown, key = 'data'): readonly T[] {
  if (Array.isArray(payload)) return payload as readonly T[];
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const named = record[key];
    if (Array.isArray(named)) return named as readonly T[];
    const data = record['data'];
    if (Array.isArray(data)) return data as readonly T[];
    const items = record['items'];
    if (Array.isArray(items)) return items as readonly T[];
  }
  return [];
}

/**
 * The node out of a write response, whether it came back bare or wrapped.
 *
 * §2.5 documents `{node, variables_created}` for create and `→ node` for move, so both spellings
 * are contract-legal and a component should not care which one it got. The runtime check is on the
 * four structural fields for the reason this file's header gives: a row without them is a bug to
 * see, not one to paper over.
 */
export function nodeOf(payload: unknown): TreeRowWire | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const wrapped = record['node'];
  const candidate =
    wrapped !== null && typeof wrapped === 'object' ? (wrapped as Record<string, unknown>) : record;
  // A write returns the node ROW (`node_kind`, `label_key`); the tree speaks in TREE ROWS
  // (`kind`, `label_preview`). Translating here is what lets a created node appear in the outline
  // without a refetch.
  const kind = candidate['kind'] ?? candidate['node_kind'];
  const label = candidate['label_preview'] ?? candidate['label_key'] ?? candidate['title_key'];
  if (typeof candidate['id'] !== 'string' || typeof kind !== 'string') return undefined;
  if (typeof candidate['sort_key'] !== 'string') return undefined;
  return {
    ...(candidate as unknown as TreeRowWire),
    kind: kind as NodeKind,
    label_preview: typeof label === 'string' ? label : null,
  };
}

export function normalizeEmitted(wire: EmittedVariableWire): EmittedVariable {
  return {
    name: wire.name,
    kind: wire.kind ?? 'question',
    vtype: wire.vtype ?? wire.type ?? 'unknown',
    exportColumn: wire.export_column ?? wire.export?.column ?? null,
    pii: wire.pii === true,
  };
}

export function normalizeNode(wire: NodeBodyWire): NodeBody {
  const items = wire.items ?? wire.options ?? [];
  const emits = wire.emits ?? wire.variables ?? [];
  return {
    id: wire.id,
    kind: wire.kind ?? wire.node_kind ?? 'question',
    ref: wire.ref ?? null,
    // A block or a page names its copy `title_key`, a question `label_key`; one field on screen.
    label: wire.label ?? wire.label_key ?? wire.title_key ?? null,
    instruction: wire.instruction ?? wire.instruction_key ?? null,
    questionType: wire.question_type ?? null,
    required: wire.required === true,
    config: wire.config ?? {},
    items: items.filter((item) => (item.deleted_at ?? null) === null),
    emits: emits.map(normalizeEmitted),
    deletedAt: wire.deleted_at ?? null,
  };
}

/**
 * The node body out of `GET /nodes/{id}`, whose response is an ENVELOPE: `{node, items, cells,
 * validation, masks, scripts, rules, variables}` — the includes are siblings of the node rather
 * than fields on it, because `?include=validation` has to mean something even when `validation` is
 * a column of the row. So the envelope is flattened here, once, and every component downstream
 * sees one `NodeBody`.
 */
export function normalizeNodeResponse(payload: unknown): NodeBody | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const inner = record['node'];
  const node = (
    inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : record
  ) as unknown as NodeBodyWire;
  if (typeof node.id !== 'string') return null;
  const items = Array.isArray(record['items'])
    ? (record['items'] as readonly ItemWire[])
    : node.items;
  const variables = Array.isArray(record['variables'])
    ? (record['variables'] as readonly EmittedVariableWire[])
    : node.variables;
  return normalizeNode({
    ...node,
    ...(items === undefined ? {} : { items }),
    ...(variables === undefined ? {} : { variables }),
  });
}

/** The item label, whichever field carries it. */
export function itemLabel(item: ItemWire): string {
  return item.label ?? item.label_preview ?? '';
}

/**
 * A readable name for an i18n key, until studio's own UI bundle exists.
 *
 * Plugin metadata names translations (`displayName: 'qt.consent.name'`) and studio has no UI
 * bundle in Phase 1 — translation management (P1-12) is about *survey* copy, not chrome. One
 * function so a real bundle replaces one call site rather than fifteen, and the fallback is the
 * plugin ID rather than the key's tail: `qt.consent.name` humanizes to "Name", which is useless
 * in a type picker.
 */
export function humanizeId(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
