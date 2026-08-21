/**
 * The validation executor — schema C §14, run at E §5 step 4.
 *
 * Schema §14's rule types (`required`, `min_selections`, `sum_equals`, `regex`, …) are NOT
 * lowered to logic rules — only authored `kind: 'validation'` logic rules are, and those
 * surface through `Verdict.validations`. These per-question rules ship on `CompiledQuestion`
 * verbatim and someone has to execute them; E §12.1's bundle budget names this module
 * ("PRNG, piping, masking, validation executor") as shared client/server code, which is why
 * it lives here and takes its expression evaluator by injection: byte-identical verdicts on
 * both sides is what keeps a validation message from flickering between keystroke and submit.
 *
 * Two ordering rules from E §5 step 4, both load-bearing:
 *
 *   PER-FIELD FIRST, THEN PAGE-SCOPE. A sum-to-100 over three numerics is meaningless while
 *   one of them failed a range check; reporting both at once tells the respondent to fix a
 *   total that will change anyway.
 *
 *   REQUIRED-BUT-NOT-SHOWN IS IMPOSSIBLE BY CONSTRUCTION. The caller passes the `shown` and
 *   `required` sets from the AUTHORITATIVE re-evaluation (E §5 step 2), so a question logic
 *   hid is simply not in them. This module never decides visibility; it only respects it.
 *
 * A failure is a genuine no-op upstream: the caller returns the re-rendered page and touches
 * nothing (E §5 step 4 — "no event, no document write, no variable mutation, no quota call").
 * That contract is the caller's; this module's contract is just "given these values, which
 * rules fail".
 */

export interface ValidationRuleLike {
  readonly id: string;
  readonly type: string;
  readonly params?: { readonly [k: string]: unknown };
  readonly condition?: unknown | null;
  readonly message_key?: string | null;
  readonly scope?: 'field' | 'page';
}

export interface ValidateQuestion {
  readonly id: string;
  readonly ref: string;
  readonly required?: boolean;
  readonly validation?: readonly ValidationRuleLike[];
  /** The variables this question emits — what `required` means "at least one of these". */
  readonly emits?: readonly string[];
}

export interface ValidationFailure {
  readonly rule_id: string;
  readonly question_id: string;
  readonly type: string;
  readonly message_key: string;
  readonly scope: 'field' | 'page';
}

export interface ValidateInput {
  /** The page's questions, in document order — order of failures follows it. */
  readonly questions: readonly ValidateQuestion[];
  /** Questions the AUTHORITATIVE evaluation says were shown (E §5 step 2). */
  readonly shown: ReadonlySet<string>;
  /** The variable state as it would be AFTER this submit — stored vars + filtered values. */
  readonly vars: { readonly [variableId: string]: unknown };
  /** The variables THIS submit wrote, so `required` can distinguish "empty" from "untouched". */
  readonly written: ReadonlySet<string>;
  /**
   * Evaluate an `expression` / `cross_question` condition against `vars`. Kleene: `null` is
   * UNKNOWN, and UNKNOWN passes — a validation that cannot be evaluated must not trap the
   * respondent, matching D §2.5's collapse direction for validations.
   */
  readonly evalCondition?: (condition: unknown) => boolean | null;
}

/* ------------------------------------------------------------------ *
 * Value predicates
 * ------------------------------------------------------------------ */

/** "Answered" for requiredness: null, undefined, '', and [] are all non-answers. */
function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function selectionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return isAnswered(value) ? 1 : 0;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The executor
 * ------------------------------------------------------------------ */

const DEFAULT_MESSAGES: { readonly [type: string]: string } = {
  required: 'err.required',
  min_selections: 'err.min_selections',
  max_selections: 'err.max_selections',
  min_value: 'err.min_value',
  max_value: 'err.max_value',
  sum_equals: 'err.sum_equals',
  regex: 'err.format',
  expression: 'err.invalid',
  cross_question: 'err.invalid',
};

/**
 * Run one page's validations. Failures come back per-field first, then page-scope, each list
 * in document order — the order the messages should render in.
 *
 * Page-scope rules are SKIPPED when any per-field rule failed, per the header's ordering
 * argument. `required` uses `question.required` plus any explicit `required` rule; an
 * explicit rule wins on message_key so an author can brand the message.
 */
export function runValidations(input: ValidateInput): readonly ValidationFailure[] {
  const fieldFailures: ValidationFailure[] = [];
  const pageRules: Array<{ q: ValidateQuestion; rule: ValidationRuleLike }> = [];

  for (const q of input.questions) {
    if (!input.shown.has(q.id)) continue; // hidden questions validate nothing, ever

    const rules = q.validation ?? [];
    const explicitRequired = rules.find(r => r.type === 'required');

    // Implicit requiredness from the question flag, when no explicit rule restates it.
    if (q.required && !explicitRequired && !questionAnswered(q, input.vars)) {
      fieldFailures.push({
        rule_id: `req:${q.id}`,
        question_id: q.id,
        type: 'required',
        message_key: 'err.required',
        scope: 'field',
      });
    }

    for (const rule of rules) {
      if ((rule.scope ?? 'field') === 'page') {
        pageRules.push({ q, rule });
        continue;
      }
      const failure = runFieldRule(q, rule, input);
      if (failure) fieldFailures.push(failure);
    }
  }

  if (fieldFailures.length > 0) return fieldFailures;

  const pageFailures: ValidationFailure[] = [];
  for (const { q, rule } of pageRules) {
    const failure = runPageRule(q, rule, input);
    if (failure) pageFailures.push(failure);
  }
  return pageFailures;
}

function questionAnswered(q: ValidateQuestion, vars: ValidateInput['vars']): boolean {
  const emits = q.emits ?? [];
  if (emits.length === 0) return true; // a question that emits nothing cannot be unanswered
  return emits.some(v => isAnswered(vars[v]));
}

function fail(
  q: ValidateQuestion,
  rule: ValidationRuleLike,
  scope: 'field' | 'page',
): ValidationFailure {
  return {
    rule_id: rule.id,
    question_id: q.id,
    type: rule.type,
    message_key: rule.message_key ?? DEFAULT_MESSAGES[rule.type] ?? 'err.invalid',
    scope,
  };
}

/** The variables a rule reads: its own params.variables, else the question's emits. */
function ruleVars(q: ValidateQuestion, rule: ValidationRuleLike): readonly string[] {
  const declared = rule.params?.['variables'];
  if (Array.isArray(declared)) return declared.filter((v): v is string => typeof v === 'string');
  return q.emits ?? [];
}

function runFieldRule(
  q: ValidateQuestion,
  rule: ValidationRuleLike,
  input: ValidateInput,
): ValidationFailure | null {
  const vars = ruleVars(q, rule);
  const primary = input.vars[vars[0] ?? ''];

  switch (rule.type) {
    case 'required':
      return questionAnswered(q, input.vars) ? null : fail(q, rule, 'field');

    case 'min_selections': {
      const n = asNumber(rule.params?.['n']) ?? 1;
      // An untouched optional question does not fail min_selections — that would make every
      // min_selections an implicit required. It applies once the respondent selected anything.
      if (!questionAnswered(q, input.vars)) return null;
      return selectionCount(primary) >= n ? null : fail(q, rule, 'field');
    }

    case 'max_selections': {
      const n = asNumber(rule.params?.['n']);
      if (n === null) return null; // an unparameterized max constrains nothing
      return selectionCount(primary) <= n ? null : fail(q, rule, 'field');
    }

    case 'min_value': {
      const bound = asNumber(rule.params?.['value'] ?? rule.params?.['n']);
      const v = asNumber(primary);
      if (bound === null || v === null) return null;
      return v >= bound ? null : fail(q, rule, 'field');
    }

    case 'max_value': {
      const bound = asNumber(rule.params?.['value'] ?? rule.params?.['n']);
      const v = asNumber(primary);
      if (bound === null || v === null) return null;
      return v <= bound ? null : fail(q, rule, 'field');
    }

    case 'regex': {
      const pattern = rule.params?.['pattern'];
      if (typeof pattern !== 'string' || typeof primary !== 'string' || primary === '') {
        return null; // format rules apply to entered text, not to absence — required covers that
      }
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        // A malformed pattern is a compile-time defect (the compiler validates these); at
        // runtime the respondent must not be trapped behind it.
        return null;
      }
      return re.test(primary) ? null : fail(q, rule, 'field');
    }

    case 'expression': {
      const verdict = input.evalCondition?.(rule.condition ?? rule.params?.['condition']);
      // TRUE means valid. UNKNOWN passes — see the input's doc comment.
      return verdict === false ? fail(q, rule, 'field') : null;
    }

    default:
      // A plugin-declared type this executor does not know. Passing is the only safe answer:
      // the plugin's own client behaviour enforces it for UX, and blocking a respondent on a
      // rule the server cannot evaluate is a dead end. The compiler warns on unknown types.
      return null;
  }
}

function runPageRule(
  q: ValidateQuestion,
  rule: ValidationRuleLike,
  input: ValidateInput,
): ValidationFailure | null {
  switch (rule.type) {
    case 'sum_equals': {
      const target = asNumber(rule.params?.['value']);
      if (target === null) return null;
      const vars = ruleVars(q, rule);
      let sum = 0;
      let any = false;
      for (const v of vars) {
        const n = asNumber(input.vars[v]);
        if (n !== null) {
          sum += n;
          any = true;
        }
      }
      if (!any) return null; // nothing entered yet — required covers emptiness
      return sum === target ? null : fail(q, rule, 'page');
    }

    case 'cross_question':
    case 'expression': {
      const verdict = input.evalCondition?.(rule.condition ?? rule.params?.['condition']);
      return verdict === false ? fail(q, rule, 'page') : null;
    }

    default:
      return null;
  }
}
