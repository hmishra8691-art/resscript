/**
 * The `rescript` Monaco language: registration data, language configuration, and the Monarch
 * tokenizer — 09-ui §7.4, verbatim where that section is explicit.
 *
 * Nothing here imports `monaco-editor` at RUNTIME. Every export is plain data typed against
 * Monaco's declaration file (`import type`), so this module is free to sit in a route's entry
 * graph while the 100 MB editor stays behind the `import()` in `load.ts`. `register.ts` is the
 * only file that hands these objects to a live `monaco` namespace.
 *
 * ## The tokenizer is not the parser
 *
 * Monarch is a regex state machine; `@resscript/rescript-dsl` is a recovering recursive-descent
 * parser. They *will* disagree — a `#` inside a string, a dotted option ref that spells a keyword
 * (`Q5.None`, README open decision 16). §7.4 fixes the rule for when they do: **colouring is
 * wrong and behaviour is right**, and colouring never makes a decision. So this file produces
 * `foreground` classes and nothing else: no folding of semantics into token names that another
 * module then branches on.
 *
 * ## Why the keyword list is categorised here rather than imported wholesale
 *
 * `keywordList()` from the DSL is one flat array, and Monarch needs the words split by the colour
 * they should get (`IF` is a keyword, `AND` is an operator, `TRUE` is a constant). A single
 * imported array would therefore colour `TRUE` as a statement keyword, which is the kind of
 * detail that makes an editor feel unfinished. The split is a literal table — and
 * `__tests__/monarch-keywords.test.ts` derives the authority from `@resscript/rescript-dsl` and
 * fails by name if the two ever diverge, so a keyword added to the grammar cannot stay
 * uncoloured. That test is the contract; this table is only its subject.
 */

import type * as monaco from 'monaco-editor';

export const RESCRIPT_LANGUAGE_ID = 'rescript';
export const RESCRIPT_EXTENSIONS: readonly string[] = ['.rsl'];
export const RESCRIPT_ALIASES: readonly string[] = ['ResScript'];

/**
 * Words that read as operators in an expression. `ALL`, `ANY` and `NONE` are here rather than in
 * `MONARCH_KEYWORDS` because their only expression role is `ALL OF` / `ANY OF` / `NONE OF`
 * (parser.ts `relExpr`), and colouring them as statement keywords would make a condition line
 * look like it contained three statements.
 */
export const MONARCH_OPERATOR_KEYWORDS: readonly string[] = [
  'AND', 'OR', 'NOT', 'MOD', 'BETWEEN', 'CONTAINS', 'ANY', 'ALL', 'NONE', 'OF', 'IN',
];

/** Literal keywords. `TRUE`/`FALSE`/`NULL` are values, not syntax, and are coloured as such. */
export const MONARCH_CONSTANT_KEYWORDS: readonly string[] = ['TRUE', 'FALSE', 'NULL'];

/** Everything else the lexer reserves: statements, clauses, flags, targets, randomization. */
export const MONARCH_KEYWORDS: readonly string[] = [
  // statements and definitions
  'QUESTION', 'BLOCK', 'PAGE', 'END', 'QUOTA', 'PRIORITY', 'GROUP',
  // question clauses
  'TYPE', 'LABEL', 'INSTRUCTION', 'REQUIRED', 'OPTIONAL', 'OPTIONS', 'ROWS', 'COLUMNS',
  'VALIDATE', 'RANDOMIZE', 'MASK', 'PIPE',
  // option flags
  'EXCLUSIVE', 'ANCHOR', 'SPECIFY', 'META', 'VISIBLE', 'ENABLED', 'PRESELECT', 'AUTOSELECT',
  // validate rules
  'SELECT', 'AT', 'LEAST', 'MOST', 'EXACTLY', 'SUM', 'RANGE', 'MATCHES', 'MESSAGE', 'REQUIRE',
  // rules and actions
  'IF', 'THEN', 'ELSE', 'ON', 'UNKNOWN', 'SHOW', 'HIDE', 'SKIP', 'TO', 'TERMINATE', 'AS',
  'CUSTOM', 'SET', 'DISABLE', 'ENABLE', 'UNREQUIRE', 'FLAG',
  // targets
  'OPTION', 'ROW', 'COLUMN', 'WHERE',
  // randomization
  'KEEP', 'FIRST', 'LAST', 'PLACE', 'SUBSET', 'SUBBLOCKS', 'EVENLY', 'ROTATE', 'CHILDREN',
  // masking and piping
  'EXCEPT', 'SELECTED', 'WHEN', 'EMPTY', 'FROM', 'CODE', 'LIST',
  // expression forms that are not operators
  'CASE', 'NULLS', 'ITERATIONS', 'FAIL', 'ERROR',
  // type words, which appear where a literal is expected (`DATE "2026-01-01"`, `SPECIFY TEXT`)
  'TEXT', 'DATE',
];

/**
 * 09-ui §7.4's `setLanguageConfiguration` call, with two deliberate deviations recorded here
 * rather than settled quietly:
 *
 *  1. **`lineComment: '#'`.** §7.4 says `#`; D §6.2 declares `--` and `/* *\/`. The lexer accepts
 *     all three and preserves the author's marker verbatim, so this only decides what ⌘/ inserts.
 *     Kept as §7.4 wrote it — this is the UI document and this is a UI setting — and `--` is
 *     still coloured as a comment by the tokenizer. Recorded as an open decision in the DSL
 *     README (item 1) and it should be settled in the docs, not here.
 *  2. **`ELSEIF` in `decreaseIndentPattern`.** §7.4 lists it; the grammar has no `ELSEIF` and
 *     `keywordList()` does not contain it. Left in place because a de-indent pattern that matches
 *     a word the language lacks is inert, while removing it would make this block differ from the
 *     spec for no behavioural gain. `LOOP` in the indent/folding patterns is the same case
 *     (deferred to P2-02).
 */
export const RESCRIPT_LANGUAGE_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#', blockComment: ['/*', '*/'] },
  brackets: [
    ['(', ')'],
    ['[', ']'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '"', close: '"' },
  ],
  indentationRules: {
    increaseIndentPattern: /^\s*(IF|QUESTION|OPTIONS|BLOCK|PAGE|LOOP)\b.*$/i,
    decreaseIndentPattern: /^\s*(END|ELSE|ELSEIF)\b/i,
  },
  folding: {
    markers: {
      start: /^\s*(QUESTION|BLOCK|PAGE|OPTIONS|LOOP)\b/i,
      end: /^\s*END\b/i,
    },
  },
};

/**
 * The Monarch tokenizer. Colouring only (see the header).
 *
 * `ignoreCase: true` is what makes the uppercase tables above match `if` and `If` as well —
 * Monaco lowercases both the table and the matched word (`monarchCompile.createKeywordMatcher`).
 * That mirrors D §6.2 exactly: keywords are case-insensitive, refs are not, and the `identifier`
 * rule below therefore never lowercases anything.
 */
export const RESCRIPT_MONARCH: monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  defaultToken: '',
  // Consumed by the `cases` guards below; Monarch reads them off the language object by name.
  keywords: [...MONARCH_KEYWORDS],
  operatorKeywords: [...MONARCH_OPERATOR_KEYWORDS],
  constants: [...MONARCH_CONSTANT_KEYWORDS],
  tokenizer: {
    root: [
      // Comments first: all three markers D §6.2 and §7.4 between them name.
      [/#.*$/, 'comment'],
      [/--.*$/, 'comment'],
      [/\/\*/, 'comment', '@blockComment'],

      // The dotted option-ref form (`Q1.Yes`, `BRAND.label`). Emitted as two tokens so the head
      // reads as a reference and the member as a property — a single token would colour
      // `Q5.None` entirely as a keyword, which is exactly the Monarch/parser disagreement the
      // header says to expect and to keep cosmetic.
      [/([A-Za-z_][A-Za-z0-9_]*)(\.)([A-Za-z_][A-Za-z0-9_]*)/, ['variable', 'delimiter', 'variable.name']],

      // A call name is only a call because of the `(` that follows (tokens.ts: function names are
      // deliberately not reserved), so the lookahead is load-bearing rather than cosmetic.
      [/[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/, 'entity.name.function'],

      [
        /[A-Za-z_][A-Za-z0-9_]*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@operatorKeywords': 'keyword.operator',
            '@constants': 'constant.language',
            '@default': 'variable',
          },
        },
      ],

      [/"/, 'string', '@string'],

      // Numbers before punctuation so `-1` and `1.5` do not split.
      [/\d+\.\d+/, 'number.float'],
      [/\d+/, 'number'],

      // PUNCTUATION from tokens.ts, longest match first for the same reason the lexer needs it.
      [/==|<=|>=|<>|!=|[=<>]/, 'operator'],
      [/[+\-*/%]/, 'operator'],
      [/[()[\]{}]/, '@brackets'],
      [/[,.]/, 'delimiter'],
      [/[ \t\r\n]+/, 'white'],
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    blockComment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
};
