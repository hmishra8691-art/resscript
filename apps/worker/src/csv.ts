/**
 * RFC 4180 CSV encoding — the whole of it, in three functions and zero dependencies.
 *
 * Hand-rolled on purpose. The rules fit in one sentence — quote a field containing a comma, a
 * double quote or a line break, and double the quotes inside — and a streaming export writes
 * one row at a time, which is precisely the shape most CSV libraries obscure behind a
 * whole-document API. A dependency here would be a supply-chain surface for ten lines of code
 * on the path that handles respondent data.
 *
 * Three decisions of record, each the flat-file convention rather than a preference:
 *
 *  * **CRLF row terminators** (RFC 4180 §2.1). SPSS, Excel and R all accept either; the RFC
 *    names one, so the export is byte-deterministic and the MVP journey's "diff against a
 *    committed expected file" (roadmap P1-12 Accept) never fails on invisible characters.
 *  * **UTF-8, no BOM.** A BOM makes the first header cell `﻿Q1` for every consumer that
 *    is not Excel-double-clicking; the P5-02 export dialog can offer a BOM variant when a
 *    customer asks for one.
 *  * **Minimal quoting.** Only fields that need quotes get them — quoting everything is legal
 *    but doubles the size of a codes-only file whose fields are mostly one digit.
 *
 * NULL-vs-empty is deliberately NOT this module's concern: CSV has one empty cell and no way
 * to spell the difference, so the mapping (absent value → empty, PII-suppressed → empty) is
 * the export job's decision and is documented there.
 */

/** The RFC 4180 row terminator. Exported so tests and the writer agree by construction. */
export const CSV_EOL = '\r\n';

const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Encode one field. Everything is a string by the time it gets here — turning a survey VALUE
 * into a string (codes, `;`-joined sets, empty for NULL) is `kinds/export.ts`'s job, because
 * that mapping is survey semantics and this file is bytes.
 */
export function encodeCsvField(field: string): string {
  if (!NEEDS_QUOTING.test(field)) return field;
  return `"${field.replaceAll('"', '""')}"`;
}

/** Encode one row, WITH its terminator, so a caller cannot forget the final newline. */
export function encodeCsvRow(fields: readonly string[]): string {
  return fields.map(encodeCsvField).join(',') + CSV_EOL;
}

/**
 * The inverse, for tests — NOT a general CSV reader (no BOM handling, no header inference,
 * whole-document only). Kept next to the encoder so the round-trip property ("a value
 * containing `","` or an embedded newline survives") is asserted against this pair, and a
 * mismatch between the two is a failure in this module rather than a mystery in a fixture.
 *
 * A quoted field may contain the row terminator, so this cannot be `split(CSV_EOL)` per line:
 * it walks the document once with a two-state machine, the same grammar the encoder targets.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
    }
  }
  // A well-formed RFC 4180 document ends in CRLF, so nothing is pending here; tolerating a
  // trailing unterminated row keeps the parser useful on hand-edited fixtures.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
