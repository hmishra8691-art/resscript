/**
 * A synthetic composing parent, for testing composable plugins before `matrix` exists.
 *
 * `matrix` is P1-05. A plugin that ships in P1-04 declaring `composable: true` is making a promise
 * about a parent nobody has written yet, and an untested promise about the composition rules is
 * exactly how F §3's claim ("the contract is sufficient") would turn out to be false at the moment
 * it mattered. This parent composes one child per row and does nothing else, so a failure is the
 * child's or the kit's, never a real plugin's.
 */

import type { JsonObject } from '@resscript/schema';
import type { QuestionTypePluginCore } from '../contract/plugin.js';
import type { VariableDeclaration } from '../contract/variables.js';
import type { JsonSchema } from '../json-schema.js';
import { ok, type ResponseCodec } from '../contract/codec.js';

export interface TestParentConfig {
  readonly childType: string;
  readonly useColumns: boolean;
  /**
   * The child's config, as the editor would have written it at insertion time.
   *
   * Required rather than optional, and that is the interesting part: a cell control with no config
   * is a compile error whenever the child's schema has required fields, because `defaultConfig` is
   * an *authoring-time* function (F §1: "defaults applied when the editor inserts a new question")
   * and `declareVariables` runs long after insertion, with no language and no editor. Filling
   * defaults at compile time would make the compiled artifact depend on the plugin version's
   * defaults rather than on what the author actually approved.
   */
  readonly childConfig: JsonObject;
}

export type TestParentAnswer = Readonly<Record<string, unknown>>;

const TEST_PARENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['childType'],
  properties: {
    childType: { type: 'string', minLength: 1 },
    useColumns: { type: 'boolean', default: true },
    childConfig: { type: 'object' },
  },
};

const codec: ResponseCodec<TestParentConfig, TestParentAnswer> = {
  parse: (raw) => ok((raw ?? {}) as TestParentAnswer),
  toVariables: () => ({}),
  fromVariables: () => ({}),
  emptyAnswer: () => ({}),
};

export const testParentCore: QuestionTypePluginCore<TestParentConfig, TestParentAnswer> = {
  meta: {
    id: 'test_parent',
    version: '1.0.0',
    displayName: 'qt.test_parent.name',
    description: 'qt.test_parent.desc',
    category: 'grid',
    icon: 'grid',
    entitlementKey: null,
    trust: 'first_party',
    composable: false,
    emitsData: true,
  },
  configSchema: TEST_PARENT_SCHEMA,
  defaultConfig: () => ({ childType: 'single_select', useColumns: true, childConfig: {} }),

  declareVariables(ctx) {
    const out: VariableDeclaration[] = [];
    ctx.rows.forEach((row, index) => {
      const children = ctx.compose(
        { kind: 'row', rowRef: row.ref, rowCode: row.code, index: index + 1 },
        {
          question_type: ctx.config.childType,
          config: ctx.config.childConfig,
          use_columns: ctx.config.useColumns,
        },
      );
      for (const child of children) {
        out.push({
          ...child,
          export: {
            ...child.export,
            // F §3.1's arithmetic: the row's block of a hundred, then the child's own order within
            // the cell. Derived from the row *code*, so dragging a row does not renumber columns.
            order: row.code * 100 + child.export.order,
            labelKey: row.labelKey,
          },
          analysis: { ...(child.analysis ?? { measure: 'nominal' }), batteryRef: ctx.ref },
        });
      }
    });
    return out;
  },

  validate: () => [],
  codec,
  exportContribution: {
    columnLabel: (_declaration, ctx) => ctx.t(ctx.question.label),
    valueLabels: () => [],
  },
  a11y: {
    interactionModel: 'grid',
    requiredRoles: ['grid'],
    keys: ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space'],
    minTouchTargetPx: 44,
    pointerDependent: false,
    rtlSafe: true,
  },
};
