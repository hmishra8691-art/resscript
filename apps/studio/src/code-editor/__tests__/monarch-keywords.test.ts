/**
 * THE keyword-parity test. 09-ui §7.4: "A CI test parses every keyword out of the grammar and
 * asserts the Monarch keyword list matches, so adding a keyword to the language cannot leave it
 * uncoloured."
 *
 * The authority is `@resscript/rescript-dsl` — `KEYWORDS` is the reserved-word table the lexer
 * itself consults (`isKeyword`), so this suite derives the expectation from the language rather
 * than from a copy of it. Three properties, each of which fails a different mistake:
 *
 *   1. **Partition.** The union of the three Monarch categories equals the DSL's reserved set.
 *      Catches the case §7.4 names: a keyword added to the grammar and not to the tokenizer.
 *      Also catches the reverse — a word coloured as a keyword that the lexer treats as a
 *      variable name, which is worse than no colour because it tells the author the wrong thing.
 *   2. **Disjointness.** No word appears in two categories, because Monarch's `cases` guards are
 *      evaluated in order and a duplicate would make a word's colour depend on table order.
 *   3. **Lexes as one keyword token.** Each Monarch word is run through the real lexer. Set
 *      equality alone would pass a table containing `'ANY OF'` (two words, one entry); the lexer
 *      says otherwise. This is the property that keeps the table honest about what a *token* is.
 */

import { describe, expect, it } from 'vitest';
import { KEYWORDS, isKeyword, keywordList, lex } from '@resscript/rescript-dsl';
import {
  MONARCH_CONSTANT_KEYWORDS,
  MONARCH_KEYWORDS,
  MONARCH_OPERATOR_KEYWORDS,
  RESCRIPT_MONARCH,
} from '@/code-editor/language';

const MONARCH_ALL: readonly string[] = [
  ...MONARCH_KEYWORDS,
  ...MONARCH_OPERATOR_KEYWORDS,
  ...MONARCH_CONSTANT_KEYWORDS,
];

describe('the Monarch keyword table matches the grammar', () => {
  it('covers every reserved word in @resscript/rescript-dsl and no others', () => {
    // Derived, not restated: `keywordList()` exists in tokens.ts for exactly this test, and
    // `KEYWORDS` is the array `isKeyword` is built from.
    const grammar = new Set<string>(keywordList());
    expect(grammar.size).toBe(KEYWORDS.length);

    const coloured = new Set(MONARCH_ALL);
    const uncoloured = [...grammar].filter((word) => !coloured.has(word)).sort();
    const invented = [...coloured].filter((word) => !grammar.has(word)).sort();

    expect(uncoloured, 'keywords in the grammar with no Monarch colour').toEqual([]);
    expect(invented, 'Monarch entries the lexer does not reserve').toEqual([]);
  });

  it('puts each keyword in exactly one colour category', () => {
    const seen = new Map<string, number>();
    for (const word of MONARCH_ALL) seen.set(word, (seen.get(word) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([word]) => word);
    expect(duplicated, 'a word in two categories takes its colour from table order').toEqual([]);
  });

  it('every Monarch entry is a single keyword token to the real lexer', () => {
    for (const word of MONARCH_ALL) {
      expect(isKeyword(word), `${word} is not a reserved word`).toBe(true);
      // `lex` appends an `eof` token, hence 2.
      const { tokens } = lex(word);
      expect(tokens.map((t) => t.kind), `${word} does not lex as one keyword`).toEqual([
        'keyword',
        'eof',
      ]);
      expect(tokens[0]?.upper).toBe(word);
    }
  });

  it('is wired into the tokenizer object Monaco actually receives', () => {
    // The tables above would be inert if the language object referenced something else, and a
    // Monarch typo is silent: an unknown `@name` guard simply never matches.
    expect(RESCRIPT_MONARCH['keywords']).toEqual([...MONARCH_KEYWORDS]);
    expect(RESCRIPT_MONARCH['operatorKeywords']).toEqual([...MONARCH_OPERATOR_KEYWORDS]);
    expect(RESCRIPT_MONARCH['constants']).toEqual([...MONARCH_CONSTANT_KEYWORDS]);
    expect(RESCRIPT_MONARCH.ignoreCase).toBe(true);
  });
});
