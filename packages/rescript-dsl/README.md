# `@resscript/rescript-dsl`

The ResScript surface language: lexer, recovering parser, type-annotating resolver and
pretty-printer over the AST `packages/logic` owns. Deliverable D §6, milestone **P1-07**.

```ts
import { parse, print, format, contextAt, dslRegistry } from '@resscript/rescript-dsl';

const registry = dslRegistry(variableRegistryFromSchema, nodeIndexFromContentTree);

const { program, diagnostics, source_map, ok } = parse(source, registry);
const source = print(program, registry);
const { source: formatted } = format(source, registry);        // print(parse(s)) in one call
const ctx = contextAt(source, cursorOffset, registry);          // Monaco completion (09-ui §7.4)
```

Nothing here defines a node type, a type rule or a diagnostic severity — those live in
`packages/logic` and are imported (ADR-010: one definition, or preview and field disagree). What
lives here is the mapping between text and that AST, and the two guarantees over it.

## The two guarantees (D §6.4)

**T1 — AST identity.** `parse(print(a)) ≡ a`, where `≡` is structural equality after normalizing
node ids and *excluding trivia*. This is the one the visual builder depends on: a rule authored in
the builder, printed for the user to read, and reparsed, is the same rule.

**T2 — Source normalization.** `print(parse(s)) = normalize(s)`, and `print` is idempotent. The
printer may change whitespace, keyword case, `==`→`=` and redundant parentheses. It may **not**
change comments, comment position, blank-line grouping, or the author's choice of symbolic
(`Q1.Yes`) vs numeric (`1`) option references.

Both are property tests, not documentation: `src/roundtrip.prop.test.ts`.

## Running the property suite

The eight properties run at a modest case count on every PR and at 10,000 nightly, which is what
the roadmap's Phase 1 exit criteria require. R1's mitigation is explicit about why the split
exists: *a property suite slow enough to be skipped is a property suite nobody runs.*

```bash
pnpm --filter @resscript/rescript-dsl test                          # ~200 cases per property
RESSCRIPT_PROPERTY_RUNS=10000 pnpm --filter @resscript/rescript-dsl test   # the nightly count
```

10,000 cases takes about 21 s on CI-class hardware. The nightly job is `properties` in
`.github/workflows/ci.yml`.

## The corpus

`fixtures/corpus/*.rsl` holds the design document's own programs (D §6.3, D §9.2, schema §19) plus
one file per class of bug found while building. **Every survey that has ever caused a bug goes in
here permanently** — that is R1's mitigation, and it is the reason property P7 exists.

| File | What it pins |
|---|---|
| `illustrated.rsl` | D §6.3's illustrated program, near-verbatim |
| `worked-example.rsl` | D §9.2's worked example, with §9.1's label-match bug already fixed |
| `schema-19.rsl` | schema §19's "compiles to exactly this and pretty-prints back from it" |
| `trivia.rsl` | all three comment markers, blank-line grouping, author parentheses, symbolic refs |
| `structures.rsl` | `BLOCK` / `PAGE` / `PRIORITY GROUP` nesting |
| `quota-deferred.rsl` | a `QUOTA` block: must be rejected with `RSL-0007`, never mis-parsed |

## Grammar surface in this milestone

Covered: `QUESTION` (with `TYPE`, `LABEL`, `INSTRUCTION`, `REQUIRED`/`OPTIONAL`, `OPTIONS`, `ROWS`,
`COLUMNS`, `VALIDATE`, `RANDOMIZE`, `MASK`, `PIPE` and every option flag), `BLOCK`, `PAGE`, rule
statements (`IF … [ON UNKNOWN …] THEN … [ELSE …]`), bare actions, `SET`, `TERMINATE`, `RANDOMIZE`,
`MASK`, `PIPE`, `PRIORITY GROUP`, and the full expression grammar — all 58 `AST_KINDS` have a
parser production and a printer, asserted per kind in `src/closure.test.ts`.

Deferred: `QUOTA` blocks (P2-06), which parse to an `UnsupportedStmt` carrying their source text
verbatim and one `RSL-0007` diagnostic. Loops (P2-02) have a group production
(`ITERATIONS OF <q>`) but no `LOOP` statement.

## Open decisions someone must make

Each of these is a place where the source documents contradict each other or under-specify
something. The implemented choice is defensible and commented at its site; none of them should stay
unresolved, because each one is a contract with the visual builder (P1-12) and the compiler (P1-08).

1. **Comment syntax.** D §6.2 declares `--` and `/* */`; 09-ui §7.4 registers Monaco with
   `lineComment: '#'`. All three lex, the author's marker is preserved verbatim, and `#` is what
   the printer would emit for a comment it had to synthesize. **Decide which one the docs claim.**
2. **`paren_hints` vs "the printer may change redundant parentheses" (D §6.4).** Both are in T2 and
   they contradict each other. Author parentheses are preserved; property P3 therefore does not
   re-parenthesize.
3. **Symbolic vs numeric option refs, when the domain is unrecoverable.** T2 says the printer may
   not change the author's choice; T1 says the text must re-parse to the same tree. Where no operand
   can supply a literal's domain (`[1] CONTAINS 1`), the printer emits the symbolic form, because a
   formatting preference cannot outrank meaning. **Confirm that ordering.**
4. **Probe targets are ambiguous.** A scalar question emits a variable with the same name
   (schema §1), and D §2.3 distinguishes `{kind:'variable'}` from `{kind:'question'}`. A bare
   `ANSWERED(Q12)` resolves to the *variable*; `ANSWERED(QUESTION Q12)` is the question. The
   builder must render the two distinguishably.
5. **`FLAG <ident>` has no effect kind.** D §6.3 uses it; D §4.2's `Effect` union has no `flag`
   action. Resolved as a reference to a writable boolean variable, which the compiler turns into
   `set_variable … = TRUE`. **Either add the effect or bless the desugaring.**
6. **`ON UNKNOWN SHOW | HIDE | FIRE | SKIP`** — four spellings for one bit (`on_unknown: 'fire'`,
   D §4.1). The word is kept verbatim for the round trip and means nothing else.
7. **`block_def` and `page_def` are named but never defined** (D §6.2). Implemented as
   `<KEYWORD> <ref> [LABEL …] [RANDOMIZE …] <statements> END`.
8. **A bare action is a statement** (`HIDE Q3 OPTION 4`, D §6.3) but D §6.2's `statement` production
   has no such form, and `PIPE` appears at statement level in §6.3 and only as a question clause in
   §6.2. Both are accepted.
9. **`LABEL "…"` takes literal text** in D §6.3 and schema §19, while schema §16 says all
   user-visible strings are i18n keys and never inline text. The DSL carries the literal; the
   compiler must mint the key.
10. **`min`/`max` are both an `Arith` kind and an `Agg.fn`** (D §2.3). One spelling cannot mean
    both, so the aggregation forms are `MIN_OF` / `MAX_OF`.
11. **`set_eq`, `subset_of`, `union`, `intersect`, `difference`** are AST kinds with no syntax in
    D §6.2's `set_op` list. Spelled as calls.
12. **`item_attr` has a `meta_key` field but no `'meta'` member in `attr`** (D §2.3). A meta lookup
    is emitted as `attr: 'label'` plus `meta_key`; the field is ignored by the checker and the
    evaluator when `meta_key` is present, but *some* value must be canonical or a builder-authored
    and a DSL-authored meta lookup are not `exprEq`.
13. **Pages and blocks have no `ref` in logic's registry** (`PageDecl`/`BlockDecl`), so
    `SKIP TO P7` and `RANDOMIZE BLOCK MAIN` cannot resolve without a caller-supplied `NodeIndex`.
    Without one they warn (`RSL-0012`) and keep the author's text.
14. **A trailing `IF` must be on the same line.** The one newline-sensitive rule in the grammar:
    without it, `HIDE Q12` followed by `IF … THEN …` on the next line is one statement, not two.
15. **`date_lit` and `regex` are undefined tokens** in D §6.2. Implemented as `DATE "2026-01-01"`
    and a quoted string.
16. **An option ref that spells a keyword** (`Q5.None`) is lexed as a keyword and used as a
    case-sensitive name. Keywords are case-insensitive and refs are not (D §6.2), so the same token
    is both — `Q5.none` names nothing.
17. **Offsets are UTF-16 code units, not bytes.** Every consumer named in the design (Monaco, the
    API's `source_span`) counts code units.

## What this package does *not* do

- **Desugar statements into `Rule`s.** One statement is one to three rules (D §9.3) and the ids,
  `order_key`s and flow nodes are the compiler's (P1-08). Keeping the statement as the round-trip
  unit is what makes T1 provable.
- **Run the rule-level checks that need a whole `Rule`** — `LGC-T030`–`T034`, `W021`, `I002`,
  `CONFLICT`. `checkRule` in `packages/logic` does those; the DSL runs `checkExpr` plus the
  condition-must-be-boolean check (`LGC-T033`), which is the one that keeps the single coercion
  point honest.
- **The dominance-based forward-reference analysis.** D §8.1 is explicit that document order is the
  wrong test once there is a branch. What this package reports is the decidable subset: within one
  document, a rule that reads a variable emitted by a `QUESTION` defined later in the same document.
- **Monaco.** `apps/studio` owns the editor; this package owns `contextAt`, the keyword list the
  Monarch tokenizer is pinned against, positioned diagnostics, and the source map.
