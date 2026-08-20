/**
 * A minimal, structurally valid survey used as the starting point for the negative tests.
 *
 * Every diagnostic test breaks exactly one thing about this survey, so a failing assertion
 * names one cause rather than a pile of unrelated errors.
 */

import { createIdFactory } from '../ids.js';
import type { IdFactory } from '../ids.js';
import type { Survey } from '../types/survey.js';
import type { QuestionNode } from '../types/content.js';
import { applyVariableRegistry } from '../variables.js';

export function deterministicIds(seed = 12345): IdFactory {
  let a = seed;
  return createIdFactory({
    now: () => 1_700_000_000_000,
    random: () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    },
  });
}

export function makeMiniSurvey(ids: IdFactory = deterministicIds()): Survey {
  const q1: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q1',
    question_type: 'single_select',
    label: { key: 'q1.label' },
    required: true,
    options: [
      { id: ids.next('option'), ref: 'o1', code: 1, label: { key: 'q1.o1' }, position: 1 },
      { id: ids.next('option'), ref: 'o2', code: 2, label: { key: 'q1.o2' }, position: 2 },
    ],
  };
  const q2: QuestionNode = {
    id: ids.next('question'),
    type: 'question',
    ref: 'Q2',
    question_type: 'numeric',
    label: { key: 'q2.label' },
    required: false,
    config: { min: 0, max: 10 },
  };

  const blockId = ids.next('block');
  const pageId = ids.next('page');
  const startId = ids.next('flow_node');
  const sequenceId = ids.next('flow_node');
  const endId = ids.next('flow_node');

  const bare: Survey = {
    meta: { id: ids.next('survey'), ref: 'MINI', name: 'Mini survey' },
    schema_version: 2,
    settings: {
      navigation: { back_allowed: true },
      resume: { enabled: false, window_s: 3600, position: 'last_page' },
      progress_bar: { mode: 'none' },
      screenout: { show_message: false },
    },
    languages: {
      base: 'en',
      available: [{ code: 'en' }],
      bundles: {
        en: {
          'q1.label': 'Pick one',
          'q1.o1': 'Yes',
          'q1.o2': 'No',
          'q2.label': 'How many?',
        },
      },
      policy: { on_missing: 'fallback_to_base', block_publish_if_incomplete: false },
    },
    variables: [],
    content: [
      {
        id: blockId,
        type: 'block',
        ref: 'B1',
        children: [{ id: pageId, type: 'page', ref: 'P1', children: [q1, q2] }],
      },
    ],
    flow: {
      nodes: [
        { id: startId, type: 'start', next: sequenceId },
        { id: sequenceId, type: 'sequence', target_id: blockId, next: endId },
        { id: endId, type: 'end', disposition: 'COMPLETE' },
      ],
    },
    logic_rules: [],
  };

  return applyVariableRegistry(bare, { ids });
}
