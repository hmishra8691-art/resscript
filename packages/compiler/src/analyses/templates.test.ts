/**
 * `CMP-0504` — a page template with no slot for the questions (roadmap P2-12).
 *
 * `PageSettings.html_template_ref` was the last of the three dead-ended chains the P2-12 audit
 * found: declared in the schema, its id resolved by `validateStructural`, its source scanned by
 * `CMP-0500` — and emitted by no emitter and consumed by no renderer. An author who selected a page
 * template got the default shell with no indication otherwise.
 *
 * The gate this pass adds is narrow and it is an ERROR rather than a warning for a specific reason:
 * a shell with no `{{questions}}` renders a page with no form, which is invisible in an editor (the
 * template looks fine) and catastrophic in field (the respondent has nothing to answer). There is no
 * reading of the survey under which that is what the author meant.
 */

import { describe, expect, it } from 'vitest';
import type { Survey } from '@resscript/schema';

import { QUESTIONS_SLOT, analyzeTemplates } from './templates.js';

const codes = (d: readonly { code: string }[]): string[] => d.map((x) => x.code);
const TID = 'ast_0T1000000000000000000000000'.slice(0, 30);

function survey(opts: {
  readonly templateSource?: string;
  readonly refFromPage?: boolean;
  readonly refFromText?: boolean;
  readonly templateId?: string;
}): Survey {
  const id = opts.templateId ?? TID;
  return {
    content: [
      {
        id: 'blk_1',
        type: 'block',
        ref: 'B1',
        children: [
          {
            id: 'pg_1',
            type: 'page',
            ref: 'P1',
            ...(opts.refFromPage === false ? {} : { settings: { html_template_ref: id } }),
            children: [
              {
                id: 'qst_1',
                type: 'question',
                ref: 'Q1',
                question_type: 'numeric',
                ...(opts.refFromText ? { html_template_ref: id } : {}),
              },
            ],
          },
        ],
      },
    ],
    ...(opts.templateSource === undefined
      ? {}
      : {
          assets: {
            html_templates: [{ id, ref: 'SHELL', source: opts.templateSource }],
          },
        }),
  } as unknown as Survey;
}

describe('CMP-0504', () => {
  it('emits nothing when the survey has no templates', () => {
    expect(analyzeTemplates({ survey: survey({}) })).toEqual([]);
  });

  it('accepts a template containing the slot', () => {
    expect(
      codes(analyzeTemplates({ survey: survey({ templateSource: `<div>${QUESTIONS_SLOT}</div>` }) })),
    ).toEqual([]);
  });

  it('REFUSES a page template without the slot', () => {
    // The whole point: this renders a page with no form.
    const d = analyzeTemplates({ survey: survey({ templateSource: '<div>Welcome</div>' }) });
    expect(codes(d)).toEqual(['CMP-0504']);
    expect(d[0]?.severity).toBe('error');
    expect(d[0]?.detail?.['asset_ref']).toBe('SHELL');
    expect(d[0]?.detail?.['required_slot']).toBe(QUESTIONS_SLOT);
  });

  it('names the page, so the author knows where the template is used', () => {
    const d = analyzeTemplates({ survey: survey({ templateSource: '<div>x</div>' }) });
    expect(d[0]?.detail?.['page_id']).toBe('pg_1');
  });

  it('explains what breaks, not just that it is refused', () => {
    // An author's question is "what happens if I leave it", and "the respondent sees the shell and
    // nothing to answer" is the part that makes them act.
    const d = analyzeTemplates({ survey: survey({ templateSource: '<div>x</div>' }) });
    expect(d[0]?.message).toContain('no form at all');
  });

  it('does NOT apply the rule to a template used only by a TEXT node', () => {
    // A text node's template wraps a piece of copy and has no form to hold. Applying the page rule
    // to it would refuse every legitimate text template — which is why the pass distinguishes them
    // rather than scanning every template in the survey.
    const s = survey({
      templateSource: '<aside>{{note}}</aside>',
      refFromPage: false,
      refFromText: true,
    });
    expect(codes(analyzeTemplates({ survey: s }))).toEqual([]);
  });

  it('emits nothing for a template no page references', () => {
    // An unreferenced template is dead configuration, which the compiler reports elsewhere if at
    // all; a shell nobody uses cannot render a formless page.
    const s = survey({ templateSource: '<div>x</div>', refFromPage: false });
    expect(codes(analyzeTemplates({ survey: s }))).toEqual([]);
  });

  it('stays silent on a DANGLING ref rather than reporting it twice', () => {
    // `validateStructural`'s CMP-0502 owns a dangling asset id. Reporting it again under a second
    // code is what `flow.ts` and `registry.ts` both decline to do.
    const s = survey({ templateSource: '<div>x</div>', templateId: 'ast_0OTHER00000000000000000000' });
    // The page references TID, the asset is a different id.
    const withMismatch = {
      ...(s as unknown as Record<string, unknown>),
      content: (survey({}) as unknown as { content: unknown }).content,
    } as unknown as Survey;
    expect(codes(analyzeTemplates({ survey: withMismatch }))).toEqual([]);
  });

  it('uses a DOUBLE-brace slot, so piping keeps working in a shell', () => {
    // The piping engine already owns `{{VAR}}` (C §10) and a template is piped: `{{PANEL_ID}}` in a
    // page shell has to keep working. Spelling the slot like a variable and excluding it by name is
    // what makes both possible.
    expect(QUESTIONS_SLOT).toBe('{{questions}}');
  });
});
