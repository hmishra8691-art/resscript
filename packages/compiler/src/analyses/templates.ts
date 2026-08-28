/**
 * `CMP-0504`: a page HTML template that cannot hold the questions — C §14, roadmap P2-12.
 *
 * ## The chain this closes
 *
 * `PageSettings.html_template_ref` and `TextNode.html_template_ref` are declared in the schema,
 * their ids resolved by `validateStructural`, and their source scanned by the HTML sanitizer
 * (`CMP-0500`). Nothing emitted them into the artifact and no renderer consumed them, so an author
 * who selected a page template got the default shell and no indication otherwise. It was the last
 * of the three dead-ended chains the P2-12 audit found — `theme_id → theme_ref → nothing` and
 * `content.code_assets → no TypeScript at all` were the other two.
 *
 * ## Why a placeholder, and why its absence is an ERROR
 *
 * A page shell has to say where the questions go. The alternative designs are worse: appending the
 * questions after the template makes the template a header rather than a shell, and inferring a
 * slot from the markup means guessing.
 *
 * So a page template must contain `{{questions}}`. A template without it renders a page a
 * respondent cannot answer — the form is simply absent — and that is not a warning, because there
 * is no reading of the survey under which it is what the author meant. It is also invisible in a
 * visual editor: the template looks fine, the preview looks fine until somebody notices the
 * questions are gone.
 *
 * `{{questions}}` and not a single-brace form, because the piping engine already owns `{{VAR}}`
 * (C §10) and a template is piped: `{{PANEL_ID}}` in a page shell has to keep working. The slot is
 * therefore spelled like a variable and excluded from piping by name — see `render/html.ts`.
 *
 * ## What is NOT checked here
 *
 * That the template is safe. `CMP-0500` owns that, against an allowlist, and this pass deliberately
 * does not re-scan: two scanners disagreeing about one string is how a bypass gets a second
 * opinion. This pass is about STRUCTURE — does the shell have a hole for the form — and it runs on
 * templates `CMP-0500` has already accepted.
 */

import { pointer, type Survey } from '@resscript/schema';

import { cmpDiagnostic, sortCompileDiagnostics, type CompileDiagnostic } from '../diagnostics.js';

/** The slot a page shell must contain. Exported so the renderer substitutes the same token. */
export const QUESTIONS_SLOT = '{{questions}}';

export interface TemplatesInput {
  readonly survey: Survey;
}

/**
 * Which template ids are referenced from a PAGE (as opposed to a text node), and from where.
 *
 * The distinction matters: a page shell must hold the form, a text node's template wraps a piece of
 * copy and has no form to hold. Applying one rule to both would refuse every legitimate text
 * template.
 */
function pageTemplateRefs(survey: Survey): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const visit = (nodes: readonly unknown[]): void => {
    for (const raw of nodes) {
      const node = raw as {
        id?: string;
        type?: string;
        settings?: { html_template_ref?: string | null };
        children?: readonly unknown[];
      };
      if (node.type === 'page') {
        const ref = node.settings?.html_template_ref;
        if (typeof ref === 'string' && ref !== '' && !out.has(ref)) out.set(ref, node.id ?? '');
      }
      if (Array.isArray(node.children)) visit(node.children);
    }
  };
  visit(survey.content ?? []);
  return out;
}

export function analyzeTemplates(input: TemplatesInput): readonly CompileDiagnostic[] {
  const templates = input.survey.assets?.html_templates ?? [];
  if (templates.length === 0) return [];

  const referenced = pageTemplateRefs(input.survey);
  if (referenced.size === 0) return [];

  const byId = new Map(templates.map((t) => [String(t.id), t]));
  const out: CompileDiagnostic[] = [];

  // Sorted by template id so the diagnostic array does not move when content is reordered.
  for (const templateId of [...referenced.keys()].sort()) {
    const template = byId.get(templateId);
    // A dangling id is `validateStructural`'s CMP-0502 territory, not this pass's — reporting it
    // again under a second code is what `flow.ts` and `registry.ts` both decline to do.
    if (template === undefined) continue;
    if (template.source.includes(QUESTIONS_SLOT)) continue;

    out.push(
      cmpDiagnostic(
        'CMP-0504',
        `The page template ${JSON.stringify(template.ref)} does not contain ` +
          `${QUESTIONS_SLOT}, so a page using it would render with no form at all — the ` +
          'respondent sees the shell and nothing to answer. A page shell has to say WHERE the ' +
          'questions go; appending them after the template would make it a header rather than a ' +
          'shell, and inferring a slot from the markup would be guessing. This is an error rather ' +
          'than a warning because there is no reading of the survey under which a page with no ' +
          'form is what was meant, and because it looks correct in an editor right up to the ' +
          'moment somebody notices the questions are missing.',
        pointer('assets', 'html_templates'),
        {
          asset_ref: template.ref,
          asset_id: templateId,
          page_id: referenced.get(templateId) ?? '',
          required_slot: QUESTIONS_SLOT,
        },
      ),
    );
  }

  return sortCompileDiagnostics(out);
}
