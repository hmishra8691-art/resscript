/**
 * What the manifest must get right.
 *
 * The headline assertion is `variable_manifest` order, and it is asserted against
 * `survey.variables` rather than against a literal list: the promise is "the document's order and
 * nothing else", and a literal would keep passing if both sides were re-sorted the same wrong way.
 * The negative half — that it is *not* sorted by name and *not* filtered to `export.include` —
 * needs a survey where those differ from document order, which is why one variable is renamed to
 * sort first and one is excluded from the export.
 *
 * The two empty fields are asserted here as well as in `bundle.test.ts`, from opposite directions:
 * this file pins that `buildManifest` emits them empty, that file pins that `buildBundle` fills
 * them. Either one alone would pass with the addressing rule half-implemented.
 */

import { describe, expect, it } from 'vitest';
import type { Survey, Variable } from '@resscript/schema';

import { ARTIFACT_SCHEMA_VERSION } from '../types.js';
import { compileFixture, fixtureOf, buildSurvey, SURVEY_VERSION_ID } from './__fixtures__/artifact.js';
import { UNRESOLVED_AT_STORE, buildManifest, variableManifest } from './manifest.js';

describe('buildManifest', () => {
  it('identifies the artifact by its own schema version and the version it compiled from', () => {
    const { manifest, survey } = compileFixture();

    expect(manifest.artifact_schema_version).toBe(ARTIFACT_SCHEMA_VERSION);
    expect(manifest.survey_id).toBe(survey.meta.id);
    expect(manifest.survey_version_id).toBe(SURVEY_VERSION_ID);
  });

  it('emits artifact_hash and compiled_at empty, because neither can be in its own hash', () => {
    const { manifest } = compileFixture();

    expect(manifest.artifact_hash).toBe(UNRESOLVED_AT_STORE);
    expect(manifest.compiled_at).toBe(UNRESOLVED_AT_STORE);
  });

  it('lists the base language first and every other carried language in code-point order', () => {
    const { manifest } = compileFixture({ languages: ['fr', 'de'] });

    expect(manifest.base_language).toBe('en');
    expect(manifest.languages).toEqual(['en', 'de', 'fr']);
  });

  it('records the exact plugin version per resolved key, so a republish cannot drift a major', () => {
    const { manifest } = compileFixture({ withPlugins: true });

    expect(manifest.plugin_versions).toEqual({
      'multi_select@1': '1.0.0',
      'single_select@1': '1.0.0',
    });
  });

  it('records no plugin version when no registry was supplied, rather than inventing one', () => {
    const { manifest } = compileFixture();

    expect(manifest.plugin_versions).toEqual({});
  });

  it('carries the computed script hash and a CSP that pins exactly it', () => {
    const { manifest } = compileFixture({ scriptSource: 'export const a = 1;' });

    const hash = manifest.script_hashes['tracker'];
    expect(hash).toBeDefined();
    expect(manifest.csp_directives['default-src']).toEqual(["'none'"]);
    expect(manifest.csp_directives['script-src']).toEqual(["'self'", `'sha256-${hash ?? ''}'`]);
  });

  it('emits the script dispatch table — hashes say WHAT, bindings say WHEN', () => {
    // Without script_bindings the runtime knows the bytes are intact but not which hook to
    // run them on; E §13's host would be unreachable from a published artifact.
    const { manifest } = compileFixture({ scriptSource: 'export const a = 1;' });

    expect(manifest.script_bindings).toEqual([
      { ref: 'tracker', scope: 'survey', hooks: ['onPageLoad'], runs_on: 'client' },
    ]);
  });

  it('omits the table entirely for a script-free survey', () => {
    expect(compileFixture().manifest.script_bindings).toBeUndefined();
  });
});

describe('variableManifest', () => {
  it('is survey.variables order, not name order and not export-filtered', () => {
    const survey = withAwkwardVariables();

    const entries = variableManifest(survey);

    expect(entries.map((entry) => entry.name)).toEqual(survey.variables.map((v) => v.name));
    // The renamed variable sorts first by name and last by document order; the excluded one is
    // still present. Both are what a positional analysis script depends on.
    expect(entries[entries.length - 1]?.name).toBe('AAA_LAST');
    expect(entries.some((entry) => !entry.export_include)).toBe(true);
  });

  it('carries the export column and not the derived name, so a pinned layout survives', () => {
    const survey = withAwkwardVariables();

    const entries = variableManifest(survey);
    const renamed = entries.find((entry) => entry.name === 'AAA_LAST');

    expect(renamed?.export_column).toBe('LEGACY_COL_7');
  });

  it('omits enum_domain rather than emitting null for a variable that has none', () => {
    const { manifest } = compileFixture();
    const flag = manifest.variable_manifest.find((entry) => entry.name === 'FLAG_A');

    expect(flag).toBeDefined();
    expect(Object.keys(flag ?? {})).not.toContain('enum_domain');
  });

  it('carries the enum domain of an enum variable verbatim', () => {
    const { manifest, survey } = compileFixture();
    const enumVariable = survey.variables.find(
      (variable) => variable.type === 'enum' && (variable.enum_domain ?? []).length > 0,
    );
    const entry = manifest.variable_manifest.find((e) => e.id === enumVariable?.id);

    expect(entry?.enum_domain).toEqual(enumVariable?.enum_domain);
  });

  it('is the same array the manifest carries', () => {
    const { manifest, survey } = compileFixture();

    expect(manifest.variable_manifest).toEqual(variableManifest(survey));
  });
});

/**
 * The fixture survey with one variable renamed so it sorts first alphabetically while staying last
 * in document order, and one dropped from the export. Both differences are invisible to a test
 * whose fixture happens to be already sorted.
 */
function withAwkwardVariables(): Survey {
  const { survey } = buildSurvey();
  const variables: Variable[] = survey.variables.map((variable, index) => {
    if (index === survey.variables.length - 1) {
      return { ...variable, name: 'AAA_LAST', export: { include: true, column: 'LEGACY_COL_7' } };
    }
    if (index === 1) return { ...variable, export: { ...variable.export, include: false } };
    return variable;
  });
  return { ...survey, variables };
}

describe('buildManifest inputs', () => {
  it('takes the plugin resolution rather than resolving for itself', () => {
    // Two manifests over one survey, one with a registry and one without. The only field that may
    // differ is the plugin record: nothing else in the manifest is a function of the registry, and
    // a manifest that resolved plugins internally could not have that property.
    const { survey, ids } = buildSurvey();
    const withRegistry = fixtureOf(survey, ids, { withPlugins: true });
    const without = fixtureOf(survey, ids);

    expect(withRegistry.manifest.plugin_versions).not.toEqual(without.manifest.plugin_versions);
    expect({ ...withRegistry.manifest, plugin_versions: {} }).toEqual({
      ...without.manifest,
      plugin_versions: {},
    });
  });

  it('is total over a survey with no assets, no entitlements and one language', () => {
    const { survey, ids } = buildSurvey();
    const { plugins } = fixtureOf(survey, ids);

    const manifest = buildManifest({ survey, surveyVersionId: 'sv_x', plugins });

    expect(manifest.script_hashes).toEqual({});
    expect(manifest.entitlements).toEqual([]);
    expect(manifest.languages).toEqual(['en']);
  });
});
