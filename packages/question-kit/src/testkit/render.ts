/**
 * The rendering half of the harness: server-render, hydrate, and inspect.
 *
 * F §8's rendering rules are contract terms, so they need mechanical checks rather than review
 * notes. What is checkable in jsdom is checked here; what is not is stated as absent rather than
 * faked (see `spec.ts`'s header on themes and the perf budget). Concretely:
 *
 *  - **SSR + hydration** is real: `renderToString` then `hydrateRoot` on that exact markup, with
 *    `console.error` captured. A component that renders differently on the client — the classic
 *    `typeof window === 'undefined'` branch — fails here, which `harness.negative.test.tsx` proves by
 *    running a deliberately broken component through it.
 *  - **Physical-direction leakage** is a string scan of the emitted markup. Crude, and it catches
 *    the thing that actually happens: an inline `marginLeft`, a `--left` modifier class, a
 *    hardcoded `dir="ltr"`.
 *  - **Touch target size** cannot be measured without a layout engine, so the assertion is that
 *    every interactive element carries the themed class the design layer guarantees the size on
 *    (`TOUCH_TARGET_CLASS`). One indirection, and it fails when a plugin forgets.
 */

import { act, type ReactNode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { JsonValue } from '@resscript/schema';
import { TOUCH_TARGET_CLASS } from '../contract/a11y.js';
import type { ResolvedItem } from '../contract/items.js';
import type { RenderContext, RenderDevice, TextDirection } from '../contract/view.js';

export interface Announcement {
  readonly message: string;
  readonly politeness: 'polite' | 'assertive';
}

export interface TestRenderContext extends RenderContext {
  readonly announcements: readonly Announcement[];
}

export interface RenderContextOptions {
  readonly dir?: TextDirection;
  readonly device?: RenderDevice;
  readonly lang?: string;
  readonly siblings?: Readonly<Record<string, JsonValue>>;
  readonly renderChild?: RenderContext['renderChild'];
}

export const TEST_IDS = {
  labelId: 'q-label',
  instructionId: 'q-instruction',
  errorId: 'q-error',
  groupId: 'q-group',
} as const;

export function createRenderContext(options: RenderContextOptions = {}): TestRenderContext {
  const announcements: Announcement[] = [];
  return {
    lang: options.lang ?? 'en',
    dir: options.dir ?? 'ltr',
    device: options.device ?? 'desktop',
    isTest: true,
    /**
     * Identity ordering.
     *
     * The seeded PRNG is ADR-006's and lands with the runtime; what the harness needs is a
     * *deterministic* order so that a render snapshot is stable. Using the identity here also means
     * a renderer that ignores `ctx.order` and sorts items itself is not accidentally rewarded — the
     * order-independence guarantee that matters for data is asserted on `declareVariables`, where
     * it belongs.
     */
    order: (_scope: 'options' | 'rows' | 'columns', items: readonly ResolvedItem[]) => items,
    // The key itself, so an assertion can find a label by its i18n key rather than by translated
    // copy that a bundle edit would move.
    pipe: (key: string) => key,
    read: (variableName: string) => options.siblings?.[variableName],
    renderChild:
      options.renderChild ??
      ((): ReactNode => {
        throw new Error('renderChild was called but this context composes nothing');
      }),
    ids: TEST_IDS,
    announce: (message: string, politeness?: 'polite' | 'assertive') => {
      announcements.push({ message, politeness: politeness ?? 'polite' });
    },
    announcements,
  };
}

export interface RenderProbe {
  /** The server markup, byte for byte. */
  readonly html: string;
  readonly container: HTMLElement;
  /** Console output during hydration that names a mismatch. Non-empty = failed SSR contract. */
  readonly hydrationWarnings: readonly string[];
  cleanup(): void;
}

const MISMATCH = /hydrat|did ?n[o']t match|server rendered|text content/i;

/**
 * Server-render, then hydrate the same markup and watch for mismatch warnings.
 *
 * Only messages matching `MISMATCH` are collected. React also logs act-environment and update
 * warnings that are artefacts of driving it from a test rather than defects in the component, and
 * treating those as failures would train everyone to disable the check. The filter is narrow
 * enough to be honest and is exercised by a negative control, which is the only way to know a
 * filter has not silently swallowed everything.
 */
export async function renderProbe(node: ReactNode): Promise<RenderProbe> {
  const html = renderToString(node);
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);

  const warnings: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const collect =
    (fallthrough: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
      if (MISMATCH.test(text)) warnings.push(text);
      else fallthrough(...args);
    };
  console.error = collect(originalError) as typeof console.error;
  console.warn = collect(originalWarn) as typeof console.warn;

  // React's `act` refuses to run without this flag. Set through a cast rather than a `declare
  // global` so the package does not add a global to every consumer's type environment.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: { unmount(): void } | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, node);
    });
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  return {
    html,
    container,
    hydrationWarnings: warnings,
    cleanup(): void {
      root?.unmount();
      container.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Static scans over the emitted markup                                       */
/* -------------------------------------------------------------------------- */

const PHYSICAL_STYLE = /(^|[;\s])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align\s*:\s*(left|right))\s*:/i;
const PHYSICAL_CLASS = /(^|[\s_-])(left|right)$|--(left|right)(\s|$)/i;

/**
 * Physical-direction leakage in one rendered tree.
 *
 * `dir` is passed because one of the leaks is direction-specific: markup rendered for an RTL
 * respondent that hardcodes `dir="ltr"` has decided the respondent reads left to right.
 */
export function physicalDirectionLeaks(container: HTMLElement, dir: TextDirection): readonly string[] {
  const leaks: string[] = [];
  for (const element of container.querySelectorAll<HTMLElement>('*')) {
    const style = element.getAttribute('style');
    if (style !== null && PHYSICAL_STYLE.test(style)) {
      leaks.push(`${element.tagName.toLowerCase()} has physical inline style: ${style}`);
    }
    for (const token of element.classList) {
      if (PHYSICAL_CLASS.test(token)) {
        leaks.push(`${element.tagName.toLowerCase()} has physical class token: ${token}`);
      }
    }
    const declaredDir = element.getAttribute('dir');
    if (declaredDir !== null && declaredDir !== dir) {
      leaks.push(`${element.tagName.toLowerCase()} hardcodes dir="${declaredDir}" while rendering ${dir}`);
    }
    if (element.getAttribute('align') !== null) {
      leaks.push(`${element.tagName.toLowerCase()} uses the physical align attribute`);
    }
  }
  return leaks;
}

const INTERACTIVE = 'a[href], button, input, select, textarea, [role="radio"], [role="checkbox"], [role="slider"], [role="option"]';

export function interactiveElements(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(INTERACTIVE)];
}

/** Interactive elements with no touch-target class on themselves or an ancestor. */
export function untargetedElements(container: HTMLElement): readonly string[] {
  return interactiveElements(container)
    .filter((element) => element.closest(`.${TOUCH_TARGET_CLASS}`) === null)
    .map((element) => `${element.tagName.toLowerCase()}${element.getAttribute('type') === null ? '' : `[type=${String(element.getAttribute('type'))}]`}`);
}

/**
 * Tab stops among the *group's own* controls.
 *
 * Scoped to radios and checkboxes deliberately: a companion verbatim box next to an "other,
 * specify" option is legitimately its own tab stop, and counting it would make the roving-tabindex
 * assertion fail on a correct renderer. What must never happen is a 60-option list being 60 stops.
 */
export function groupTabStops(container: HTMLElement): readonly HTMLElement[] {
  const controls = container.querySelectorAll<HTMLElement>(
    'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]',
  );
  return [...controls].filter((element) => (element.getAttribute('tabindex') ?? '0') === '0');
}

/** A plugin must not mint its own live region: the page shell owns the only one (F §8). */
export function localLiveRegions(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-live], [role="alert"], [role="status"]')].map(
    (element) => element.tagName.toLowerCase(),
  );
}
