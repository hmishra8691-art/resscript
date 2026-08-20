/**
 * The single source of truth for the AST node set — D §7.2, verbatim.
 *
 * WHY it is a flat list of strings and not derived from the `Expr` union: the list is
 * consumed at *runtime* by three-way closure tests (parser / printer / builder renderer,
 * D §7.2), and a type-level union cannot be iterated. Adding a kind here without adding a
 * printer (P1-07) or a renderer (P1-12) is a build failure in those packages, which is the
 * whole enforcement mechanism for the builder/DSL isomorphism.
 */
export const AST_KINDS = [
  'lit',
  'var',
  'probe',
  'item',
  'item_attr',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'any_of',
  'all_of',
  'none_of',
  'set_eq',
  'subset_of',
  'union',
  'intersect',
  'difference',
  'and',
  'or',
  'not',
  '+',
  '-',
  '*',
  '/',
  'mod',
  'pow',
  'neg',
  'abs',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
  'clamp',
  'agg',
  'concat',
  'len',
  'lower',
  'upper',
  'trim',
  'starts_with',
  'ends_with',
  'str_contains',
  'matches',
  'substr',
  'split_count',
  'word_count',
  'date_diff',
  'date_add',
  'date_part',
  'date_trunc',
  'case',
  'coalesce',
  'cast',
  'label_of',
] as const;

export type AstKind = (typeof AST_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(AST_KINDS);

export function isAstKind(op: string): op is AstKind {
  return KIND_SET.has(op);
}

/**
 * Grouping used by the checker's error messages and by the builder's operator dropdowns.
 * Exhaustive over `AST_KINDS`: the mapped type below is what makes a new kind without a
 * family a compile error here rather than a silently uncategorised node in a UI.
 */
export type AstFamily =
  | 'leaf'
  | 'comparison'
  | 'set'
  | 'boolean'
  | 'arithmetic'
  | 'aggregation'
  | 'string'
  | 'date'
  | 'conditional';

export const AST_FAMILY: { readonly [K in AstKind]: AstFamily } = {
  lit: 'leaf',
  var: 'leaf',
  probe: 'leaf',
  item: 'leaf',
  item_attr: 'leaf',
  '==': 'comparison',
  '!=': 'comparison',
  '<': 'comparison',
  '<=': 'comparison',
  '>': 'comparison',
  '>=': 'comparison',
  contains: 'set',
  any_of: 'set',
  all_of: 'set',
  none_of: 'set',
  set_eq: 'set',
  subset_of: 'set',
  union: 'set',
  intersect: 'set',
  difference: 'set',
  and: 'boolean',
  or: 'boolean',
  not: 'boolean',
  '+': 'arithmetic',
  '-': 'arithmetic',
  '*': 'arithmetic',
  '/': 'arithmetic',
  mod: 'arithmetic',
  pow: 'arithmetic',
  neg: 'arithmetic',
  abs: 'arithmetic',
  floor: 'arithmetic',
  ceil: 'arithmetic',
  round: 'arithmetic',
  min: 'arithmetic',
  max: 'arithmetic',
  clamp: 'arithmetic',
  agg: 'aggregation',
  concat: 'string',
  len: 'string',
  lower: 'string',
  upper: 'string',
  trim: 'string',
  starts_with: 'string',
  ends_with: 'string',
  str_contains: 'string',
  matches: 'string',
  substr: 'string',
  split_count: 'string',
  word_count: 'string',
  date_diff: 'date',
  date_add: 'date',
  date_part: 'date',
  date_trunc: 'date',
  case: 'conditional',
  coalesce: 'conditional',
  cast: 'conditional',
  label_of: 'conditional',
};

/** Aggregation functions, D §2.3. */
export const AGG_FNS = [
  'count',
  'sum',
  'mean',
  'min',
  'max',
  'any',
  'all',
  'distinct_count',
  'stdev',
  'first_answered',
  'last_answered',
] as const;
export type AggFn = (typeof AGG_FNS)[number];

/** Probe kinds, D §2.3. */
export const PROBE_KINDS = ['answered', 'shown', 'valid', 'asked'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];
