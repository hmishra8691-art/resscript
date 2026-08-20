/**
 * Survey-level settings — Deliverable C §2's `settings` slot, with the field names the
 * runtime already reads (Deliverable E §7).
 */

export const PROGRESS_BAR_MODES = ['none', 'pages', 'questions', 'weighted'] as const;
export type ProgressBarMode = (typeof PROGRESS_BAR_MODES)[number];

export interface ProgressBarSettings {
  readonly mode: ProgressBarMode;
  readonly show_percentage?: boolean;
}

export const RESUME_POSITIONS = ['last_page', 'last_completed', 'restart'] as const;
export type ResumePosition = (typeof RESUME_POSITIONS)[number];

/**
 * Resume is opt-in per survey because it has a cost: a resume token has to be minted at entry
 * and carried in the page URL, and it changes what a sweeper does with a quiet session
 * (sweep to `ABANDONED` versus hold for the window).
 */
export interface ResumeSettings {
  readonly enabled: boolean;
  readonly window_s: number;
  readonly position: ResumePosition;
}

export interface NavigationSettings {
  /** Survey-wide default; a page may forbid back navigation individually (C §5). */
  readonly back_allowed: boolean;
  readonly show_page_numbers?: boolean;
  /** Server-enforced, not merely hidden in the UI: a back-submit to a closed page is a 409. */
  readonly allow_backward_edit?: boolean;
}

/** What happens to a respondent the survey rejects, beyond the redirect itself. */
export interface ScreenoutSettings {
  /** Show a message page before redirecting, so the respondent is not silently bounced. */
  readonly show_message: boolean;
  readonly message_key?: string | null;
  readonly redirect_delay_s?: number;
}

export interface QualitySettings {
  /** Speeder threshold as a fraction of median completion time, e.g. 0.4. */
  readonly speeder_threshold_ratio?: number | null;
  readonly straightliner_min_rows?: number | null;
  /** Score at or below which the runtime terminates with `QUALITY`. */
  readonly terminate_below_score?: number | null;
}

export interface SurveySettings {
  readonly navigation: NavigationSettings;
  readonly resume: ResumeSettings;
  readonly progress_bar: ProgressBarSettings;
  readonly screenout: ScreenoutSettings;
  readonly quality?: QualitySettings;
  /** Test sessions live in the same tables with `is_test = true`, never in shadow tables. */
  readonly allow_test_sessions?: boolean;
  readonly max_duration_s?: number | null;
}
