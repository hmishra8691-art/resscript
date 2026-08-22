/**
 * The CSV encoder, against hostile strings.
 *
 * Every assertion is a byte-level claim about RFC 4180, plus round-trips through `parseCsv` —
 * the pair lives in one module precisely so a quoting disagreement fails HERE and not in an
 * export diff three suites away. Survey data is adversarial by nature (an open-end IS
 * respondent-controlled input), so the fixtures are the attacks: embedded quotes, commas,
 * both newline flavours, and multilingual text.
 */

import { describe, expect, it } from 'vitest';

import { CSV_EOL, encodeCsvField, encodeCsvRow, parseCsv } from './csv.js';

describe('encodeCsvField', () => {
  it('leaves a plain field untouched — minimal quoting, not quote-everything', () => {
    expect(encodeCsvField('42')).toBe('42');
    expect(encodeCsvField('brand_grid')).toBe('brand_grid');
    expect(encodeCsvField('')).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(encodeCsvField('yes, definitely')).toBe('"yes, definitely"');
  });

  it('quotes and doubles embedded double quotes (RFC 4180 2.7)', () => {
    expect(encodeCsvField('she said "never"')).toBe('"she said ""never"""');
    expect(encodeCsvField('"')).toBe('""""');
  });

  it('quotes fields containing either newline flavour', () => {
    expect(encodeCsvField('line one\nline two')).toBe('"line one\nline two"');
    expect(encodeCsvField('line one\r\nline two')).toBe('"line one\r\nline two"');
  });

  it('passes unicode through untouched — encoding is the writer’s job, not the escaper’s', () => {
    expect(encodeCsvField('日本語の回答 — naïve café ✓')).toBe('日本語の回答 — naïve café ✓');
    // An emoji next to a comma still quotes for the comma, not for the emoji.
    expect(encodeCsvField('👍, mostly')).toBe('"👍, mostly"');
  });
});

describe('encodeCsvRow', () => {
  it('joins with commas and terminates with CRLF (RFC 4180 2.1)', () => {
    expect(encodeCsvRow(['a', 'b', 'c'])).toBe(`a,b,c${CSV_EOL}`);
  });

  it('keeps empty fields positional — NULL is the empty cell, not a missing cell', () => {
    expect(encodeCsvRow(['a', '', 'c'])).toBe(`a,,c${CSV_EOL}`);
    expect(encodeCsvRow(['', '', ''])).toBe(`,,${CSV_EOL}`);
  });
});

describe('round-trips through parseCsv', () => {
  // The property the export test leans on: whatever a respondent typed comes back exactly.
  const hostile = [
    'plain',
    '',
    'comma, inside',
    'the literal separator: ","',
    '"leading quotes"',
    'embedded "quotes" and, commas',
    'trailing quote"',
    '""',
    'newline\ninside',
    'crlf\r\ninside',
    'quote-comma-newline: ",\n"',
    '   padded   ',
    '1;3;7',
    'ユニコード, avec des "guillemets"',
  ];

  it('every hostile string survives encode → parse byte-for-byte', () => {
    const row = encodeCsvRow(hostile);
    const parsed = parseCsv(row);
    expect(parsed).toEqual([hostile]);
  });

  it('multiple rows with embedded terminators keep their row boundaries', () => {
    const rows = [
      ['r1', 'a\r\nb', 'c'],
      ['r2', '', '"x"'],
    ];
    const text = rows.map((r) => encodeCsvRow(r)).join('');
    expect(parseCsv(text)).toEqual(rows);
  });
});
