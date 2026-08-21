/**
 * `formatDiagnostic` pins two things: that a code with a formatter turns `detail` into a sentence
 * naming the objects, and that a code WITHOUT one still renders. The second matters more. Codes are
 * append-only in all three catalogues, so a deployed studio meets codes newer than itself as a
 * matter of course, and the failure mode of a missing formatter must be "less prose", never "blank
 * row".
 *
 * Assertions are on the ids and numbers that come out of `detail`, not on the gate's message prose
 * (which the component renders verbatim and which is not a contract).
 */

import { describe, expect, it } from 'vitest';
import type { CompileDiagnostic } from '@resscript/compiler/diagnostics';
import {
  formatDiagnostic,
  hasDiagnosticFormatter,
} from '@/components/publish/format-diagnostic';

/** `LGC-F001`'s detail, in `forward-ref.ts`'s spelling. Pages are ZERO-based indexes there. */
const forwardRef: CompileDiagnostic = {
  code: 'LGC-F001',
  severity: 'error',
  message: 'Rule R14 reads Q52 at page 18, flow position 31, and no path reaches that point.',
  path: '/logic/rules/3/condition',
  detail: {
    rule_id: 'R14',
    rule_kind: 'show',
    rule_target_type: 'question',
    rule_target_id: 'Q41',
    variable_id: 'v_q52',
    variable_name: 'Q52',
    blocking_variable_id: 'v_q52',
    blocking_variable_name: 'Q52',
    read_flow_node_id: 'n_18',
    read_flow_position: 31,
    read_page_id: 'p_18',
    read_page_index: 17,
    write_question_id: 'q_52',
    write_question_ref: 'Q52',
    write_flow_node_id: 'n_24',
    write_flow_position: 44,
    write_page_id: 'p_24',
    write_page_index: 23,
    availability: 'none',
  },
};

describe('formatDiagnostic', () => {
  it('names the rule, the question it is on, what it reads and both flow positions', () => {
    const formatted = formatDiagnostic(forwardRef);
    expect(formatted.summary).not.toBeNull();
    const summary = formatted.summary ?? '';
    expect(summary).toContain('R14');
    expect(summary).toContain('Q41');
    expect(summary).toContain('Q52');
    expect(summary).toContain('asked later in the flow');
    // One-based, matching the gate's own `page ${index + 1}`: two page numbers for one location on
    // one screen is worse than none.
    expect(summary).toContain('page 18');
    expect(summary).toContain('page 24');
    expect(summary).not.toContain('page 17');
  });

  it('lists the same objects as labelled subjects, so the ids are selectable', () => {
    const subjects = formatDiagnostic(forwardRef).subjects;
    expect(subjects).toEqual(
      expect.arrayContaining([
        { label: 'rule', value: 'R14' },
        { label: 'on', value: 'Q41' },
        { label: 'reads', value: 'Q52' },
        { label: 'read at', value: 'page 18' },
        { label: 'collected at', value: 'page 24' },
      ]),
    );
  });

  it('says "only some paths" for LGC-F002 when the write is not later in the flow', () => {
    const conditional: CompileDiagnostic = {
      ...forwardRef,
      code: 'LGC-F002',
      severity: 'warning',
      detail: {
        ...(forwardRef.detail ?? {}),
        availability: 'some',
        write_flow_position: 12,
        write_page_index: 5,
      },
    };
    const summary = formatDiagnostic(conditional).summary ?? '';
    expect(summary).toContain('only some of the paths');
    expect(summary).not.toContain('asked later in the flow');
  });

  it('carries the severity the diagnostic states rather than deciding one', () => {
    expect(formatDiagnostic(forwardRef).severity).toBe('error');
    expect(formatDiagnostic({ ...forwardRef, severity: 'warning' }).severity).toBe('warning');
  });

  it('renders an unknown code as its code, its message and its scalar detail', () => {
    // A code from a future `packages/compiler`. The catalogue is append-only, so this is not a
    // hypothetical: it is what every studio release sees until it is rebuilt.
    const future: CompileDiagnostic = {
      code: 'CMP-9999',
      severity: 'warning',
      message: 'the theme declares a font nobody licensed',
      path: '/theme/font_family',
      detail: { font_family: 'Helvetica Neue', licensed: false, weight_count: 3 },
    };
    expect(hasDiagnosticFormatter('CMP-9999')).toBe(false);
    const formatted = formatDiagnostic(future);
    expect(formatted.code).toBe('CMP-9999');
    expect(formatted.message).toBe('the theme declares a font nobody licensed');
    expect(formatted.path).toBe('/theme/font_family');
    expect(formatted.summary).toBeNull();
    expect(formatted.subjects).toEqual([
      { label: 'font family', value: 'Helvetica Neue' },
      { label: 'licensed', value: 'no' },
      { label: 'weight count', value: '3' },
    ]);
  });

  it('drops nulls and nested objects from the generic list instead of printing them', () => {
    const noisy: CompileDiagnostic = {
      code: 'CMP-9998',
      severity: 'error',
      message: 'something new',
      path: '',
      detail: {
        question_ref: 'Q7',
        page_id: null,
        nested: { a: 1 },
        // A list of objects is the case that would turn the row back into a JSON dump.
        entries: [{ code: '1' }, { code: '2' }],
        rule_ids: ['R1', 'R2'],
      },
    };
    expect(formatDiagnostic(noisy).subjects).toEqual([
      { label: 'question ref', value: 'Q7' },
      { label: 'rule ids', value: 'R1, R2' },
    ]);
  });

  it('survives a diagnostic with no detail at all', () => {
    const bare: CompileDiagnostic = {
      code: 'CMP-0801',
      severity: 'error',
      message: 'the compile produced no pages',
      path: '',
    };
    const formatted = formatDiagnostic(bare);
    expect(formatted.summary).toBeNull();
    expect(formatted.subjects).toEqual([]);
    expect(formatted.message).toBe('the compile produced no pages');
  });

  it('falls back to the generic list when a known code stops carrying the keys it used to', () => {
    // The shape drifted under the studio: the formatter recognises nothing, so the reader gets the
    // raw-but-labelled facts rather than an empty item.
    const drifted: CompileDiagnostic = {
      code: 'LGC-U001',
      severity: 'error',
      message: 'flow node n_9 is not reachable from start',
      path: '/flow/nodes/9',
      detail: { node: 'n_9', kind: 'branch' },
    };
    const formatted = formatDiagnostic(drifted);
    expect(formatted.summary).toBeNull();
    expect(formatted.subjects).toEqual([
      { label: 'kind', value: 'branch' },
      { label: 'node', value: 'n_9' },
    ]);
  });

  it('names the language and the missing-key count for an incomplete bundle', () => {
    const bundle: CompileDiagnostic = {
      code: 'CMP-0201',
      severity: 'warning',
      message: 'the de bundle is missing 12 of the 340 keys the en bundle declares',
      path: '/languages/bundles/de',
      detail: {
        language: 'de',
        base_language: 'en',
        bundle_present: true,
        base_key_count: 340,
        missing_count: 12,
        missing_keys: ['q1.label', 'q2.label', 'q3.label', 'q4.label'],
        truncated: false,
        on_missing: 'show_key',
        block_publish_if_incomplete: false,
        reason: 'runtime_show_key',
      },
    };
    const summary = formatDiagnostic(bundle).summary ?? '';
    expect(summary).toContain('de');
    expect(summary).toContain('12');
    expect(summary).toContain('340');
    expect(summary).toContain('q1.label');
    // Only the first few keys: the gate already truncates at 50 and a dialog row is not a list.
    expect(summary).not.toContain('q4.label');
  });
});
