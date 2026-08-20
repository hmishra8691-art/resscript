/**
 * The accessibility contract — Deliverable F §1.3 and §8.
 *
 * This is a declaration, not documentation: the test kit reads it and asserts against the
 * rendered output, so choosing `interactionModel: 'radiogroup'` commits the renderer to that
 * ARIA pattern's full keyboard behaviour and to the roles listed alongside it. A plugin that
 * fails these assertions fails CI (F §9's gate table), which is the whole reason the contract
 * is data rather than prose.
 */

export type A11yInteractionModel =
  | 'radiogroup'
  | 'checkboxgroup'
  | 'textbox'
  | 'spinbutton'
  | 'slider'
  | 'grid'
  | 'listbox'
  | 'reorder'
  | 'custom_documented';

export type A11yKey =
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'Space'
  | 'Enter'
  | 'Escape'
  | 'PageUp'
  | 'PageDown';

/**
 * The WCAG 2.2 AA floor for a touch target. Typed as a literal-bounded number rather than a
 * plain `number` so a plugin cannot declare 32 and pass its own test; F §1.3 words it as
 * "floor is 44", and a floor that a plugin can lower is not one.
 */
export const MIN_TOUCH_TARGET_PX = 44;

export interface A11yException {
  readonly rule: string;
  readonly justification: string;
  /** A real ticket. A non-empty exceptions list blocks `marketplace` promotion (F §8). */
  readonly ticket: string;
}

export interface A11yContract {
  readonly interactionModel: A11yInteractionModel;
  /** Roles the harness expects to find in the rendered output. */
  readonly requiredRoles: readonly string[];
  /** Keys the renderer must handle, asserted by the keyboard-walk test. */
  readonly keys: readonly A11yKey[];
  /** Minimum interactive target size in CSS px at the mobile breakpoint. Floor is 44. */
  readonly minTouchTargetPx: number;
  /** True if any interaction depends on pointer position (drag, click-map). */
  readonly pointerDependent: boolean;
  /** Required when `pointerDependent` — the non-pointer path, and it is tested. */
  readonly keyboardAlternative?: { readonly description: string; readonly testId: string };
  /** True if the renderer contains no physical-direction assumptions (F §8). */
  readonly rtlSafe: true;
  /** Documented deviations. A non-empty list requires a signed-off exception record. */
  readonly exceptions?: readonly A11yException[];
}

/**
 * The class every interactive target must carry.
 *
 * jsdom has no layout engine, so "≥ 44 CSS px" cannot be measured in a unit test — only in a
 * real browser. Rather than let the requirement go untested until a Playwright harness exists,
 * the sizing is pushed into one themed class that the design layer guarantees, and the kit
 * asserts the *class* is present on every interactive element. That converts an unmeasurable
 * property into a mechanically checkable one, and leaves exactly one place (the class) where
 * the real px value is defined.
 */
export const TOUCH_TARGET_CLASS = 'rs-target';

/**
 * Static coherence check on a contract. Called by the test kit before it renders anything, so
 * an incoherent declaration fails fast with a readable message instead of as a mystery
 * render assertion.
 */
export function checkA11yContract(a11y: A11yContract): readonly string[] {
  const problems: string[] = [];
  if (a11y.minTouchTargetPx < MIN_TOUCH_TARGET_PX) {
    problems.push(
      `minTouchTargetPx is ${a11y.minTouchTargetPx}; the WCAG 2.2 AA floor is ${MIN_TOUCH_TARGET_PX}`,
    );
  }
  if (a11y.requiredRoles.length === 0 && a11y.interactionModel !== 'custom_documented') {
    problems.push(`interactionModel "${a11y.interactionModel}" must name at least one role`);
  }
  if (a11y.pointerDependent && a11y.keyboardAlternative === undefined) {
    problems.push('pointerDependent contracts must declare a keyboardAlternative (F §4)');
  }
  if (!a11y.keys.includes('Tab')) {
    problems.push('every contract must handle Tab: the group has to be reachable');
  }
  for (const exception of a11y.exceptions ?? []) {
    if (exception.ticket.trim() === '') {
      problems.push(`a11y exception "${exception.rule}" has no ticket; undocumented deviation`);
    }
  }
  return problems;
}
