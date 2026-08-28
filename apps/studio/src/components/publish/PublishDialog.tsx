/**
 * The publish dialog — roadmap P1-08 Frontend: "Publish dialog with a diagnostics list separating
 * errors from warnings, per-warning acknowledgement with a recorded note, publish progress from
 * `ops.jobs`".
 *
 * FOUR REFUSALS, AND WHY EACH IS HERE RATHER THAN IN THE RESPONSE TO A CLICK.
 *
 *  1. **Errors.** `hasCompileErrors` disables publish and the warning section is not rendered at
 *     all. Not rendered rather than rendered-and-ignored: a signature box next to a publish that
 *     cannot happen teaches the author to tick boxes, and the warning list itself is provisional
 *     while the errors stand — fixing an error changes what the next compile reports, so a
 *     signature given now may be a signature on a warning that never fires.
 *  2. **Unacknowledged warnings.** The count is shown, because "Publish is disabled" with no number
 *     is a dead end. 03 §17: publishing over a warning is allowed, the acknowledgement is recorded.
 *  3. **The role floor.** K §1's asymmetry — `programmer` for staging, `project_manager` for
 *     production — is read from `PUBLISH_FLOORS` (see `capability.ts`) and shown as a DISABLED
 *     control with the reason next to it. The alternative is a 403 after the click, which spends
 *     the user's time to tell them something the studio already knew, and leaves an audit row for a
 *     refusal that was avoidable.
 *  4. **The transition.** `isLegalTransition` is the same table the route checks before queueing
 *     (H §2.4) and `app.tg_version_guard` enforces. `draft -> production` is a real mistake (the
 *     review step was skipped) and naming it here costs one function call.
 *
 * WHAT IT DOES NOT DO. It does not decide severity (imported), does not compute acknowledgement
 * identity (imported), does not re-implement progress (`JobStatus`, which M0.4 built against
 * `ops.jobs.progress`; the publish job is its first real consumer and a second progress widget
 * would be a second shape for the worker to satisfy), and does not pre-validate the survey. The
 * gate is `packages/compiler`'s and runs in the worker — a dialog that decided a publish would
 * succeed would be a second implementation of the gate, and the two would eventually disagree.
 *
 * Prop-driven, like every other control in `components/`: the mutation, the polling and the
 * invalidation belong to the container.
 */

'use client';

import { useMemo, useState } from 'react';
import type { CompileState, OrgRole, VersionStatus } from '@resscript/schema';
import {
  acknowledgementKey,
  compileErrors,
  compileWarnings,
  hasCompileErrors,
  type CompileDiagnostic,
} from '@resscript/compiler/diagnostics';
import { isLegalTransition } from '@/server/publish';
import { JobStatus } from '@/components/jobs/JobStatus';
import {
  DiagnosticList,
  type AcknowledgementState,
} from '@/components/publish/DiagnosticList';
import {
  PUBLISH_TARGETS,
  publishCapability,
  type PublishTarget,
} from '@/components/publish/capability';
import type { JobView } from '@/lib/api-types';

/** `publishVersionSchema`'s body, in its wire spelling so the container can post it verbatim. */
export interface PublishRequest {
  readonly target: PublishTarget;
  readonly acknowledge_warnings: readonly { readonly key: string; readonly reason?: string }[];
}

export interface PublishDialogProps {
  readonly versionId: string;
  readonly versionNo: number;
  readonly status: VersionStatus;
  readonly compileState: CompileState;
  /** The LAST compile's diagnostics, from `GET /versions/:id/diagnostics`. */
  readonly diagnostics: readonly CompileDiagnostic[];
  /** The viewer's role in the active org, as the membership row states it. */
  readonly role: OrgRole | null;
  /** `survey_versions.acknowledged_warnings` — keys signed by an earlier publish. */
  readonly recordedAcknowledgements?: readonly string[];
  /** The job the publish returned, polled by the container. Drives `JobStatus`. */
  readonly job?: JobView | null;
  readonly onPublish: (request: PublishRequest) => void;
  readonly onClose?: () => void;
  readonly pending?: boolean;
  /** A server-side refusal, rendered inline — never a toast that scrolls away. */
  readonly error?: string | undefined;
  readonly defaultTarget?: PublishTarget;
}

export function PublishDialog(props: PublishDialogProps): React.JSX.Element {
  const {
    versionId,
    versionNo,
    status,
    compileState,
    diagnostics,
    role,
    recordedAcknowledgements = [],
    job = null,
    onPublish,
    onClose,
    pending = false,
    error,
    defaultTarget = 'staging',
  } = props;

  const [target, setTarget] = useState<PublishTarget>(defaultTarget);
  const [acknowledgements, setAcknowledgements] = useState<ReadonlyMap<string, AcknowledgementState>>(
    new Map(),
  );

  // `compileErrors`/`compileWarnings` rather than a local `filter`: severity is a property of the
  // code, and the gate that blocks the publish is the only thing allowed to decide it.
  const errors = useMemo(() => compileErrors(diagnostics), [diagnostics]);
  const warnings = useMemo(() => compileWarnings(diagnostics), [diagnostics]);
  const blocked = hasCompileErrors(diagnostics);

  // A `Set` over the keys the version already carries. Memoised on the prop so the `outstanding`
  // memo below has a stable dependency rather than a set rebuilt on every keystroke in a note.
  const recorded = useMemo(() => new Set(recordedAcknowledgements), [recordedAcknowledgements]);
  const outstanding = useMemo(
    () =>
      warnings.filter((warning) => {
        const key = acknowledgementKey(warning);
        if (recorded.has(key)) return false;
        return acknowledgements.get(key)?.acknowledged !== true;
      }),
    [warnings, acknowledgements, recorded],
  );

  const capability = publishCapability(role, target);
  const transitionLegal = isLegalTransition(status, target);
  /*
   * `blocked` is NOT part of this, and that is the fix for a deadlock.
   *
   * `blocked` is `hasCompileErrors(diagnostics)`, and `diagnostics` is what the LAST compile
   * stored — it survives every subsequent edit untouched. Gating the button on it meant: errors
   * from a previous compile disable Publish; the only thing that clears those errors is a new
   * compile; the only way to run a compile is Publish. A version that once failed the gate could
   * never be re-published from this dialog, no matter how thoroughly its content was fixed.
   *
   * Observed on a real survey. Its labels were repaired, every reference verified resolvable in the
   * database, and the pane went on showing the errors from a compile 40 minutes earlier with the
   * button greyed out. I told the user three times to press it.
   *
   * The compiler is the gate and it runs ON publish; whether the CURRENT content compiles is
   * unknowable until it does. Stored errors describe a past state, so they inform and must not
   * disable — a publish that fails again simply re-reports accurately, which is the correct
   * outcome and costs one job.
   *
   * `outstanding` still gates — but only when the warnings are actually SHOWN. There is a second
   * deadlock underneath the first: while errors stand this dialog deliberately does not render the
   * warning section (the next compile may report a different set, and an acknowledgement is
   * recorded against the warning it was given for), and an unacknowledged warning was gating
   * anyway. So the author was blocked by something the UI refused to show them.
   *
   * Suppressed and gating cannot both be right. Since the reason for suppressing is that the
   * warning set is PROVISIONAL while errors stand, the same reasoning says it must not gate:
   * acknowledging a warning that may not survive the next compile is not a precondition worth
   * enforcing. When the errors are gone the warnings appear and gate normally, which is where
   * acknowledgement means something.
   */
  const publishable =
    (blocked || outstanding.length === 0) && capability.allowed && transitionLegal && !pending;

  const submit = (): void => {
    const signed = warnings
      .map((warning) => ({ key: acknowledgementKey(warning), state: acknowledgements.get(acknowledgementKey(warning)) }))
      .filter((entry) => entry.state?.acknowledged === true && !recorded.has(entry.key))
      .map((entry) => {
        const note = entry.state?.note ?? '';
        // `exactOptionalPropertyTypes`: an omitted `reason` and a `reason` of `undefined` are
        // different types, and `acknowledgedWarningSchema` is `.strict()`. An empty note is
        // omitted rather than sent as `""` — a blank string is not a recorded reason.
        return { key: entry.key, ...(note.trim() === '' ? {} : { reason: note.trim() }) };
      });
    onPublish({ target, acknowledge_warnings: signed });
  };

  return (
    <section
      role="dialog"
      aria-label={'Publish version ' + String(versionNo)}
      aria-modal="true"
      className="rs-card"
      data-testid="publish-dialog"
      data-version-id={versionId}
    >
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <h2>Publish version {versionNo}</h2>
        {/* K §3: `status` and `compile_state` are orthogonal, so both are stated. */}
        <span className="rs-muted" data-testid="publish-version-status">
          {status} / {compileState}
        </span>
        {onClose === undefined ? null : (
          <button
            type="button"
            className="rs-button"
            data-testid="publish-close"
            style={{ marginLeft: 'auto' }}
            onClick={onClose}
          >
            Close
          </button>
        )}
      </header>

      <CompileStateNote compileState={compileState} diagnosticCount={diagnostics.length} />

      <fieldset data-testid="publish-targets" style={{ border: 0, padding: 0, margin: '6px 0' }}>
        <legend>Target</legend>
        {PUBLISH_TARGETS.map((option) => {
          const optionCapability = publishCapability(role, option);
          const optionLegal = isLegalTransition(status, option);
          const optionDisabled = !optionCapability.allowed || !optionLegal || pending;
          return (
            <div key={option} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <input
                type="radio"
                name="publish-target"
                id={'publish-target-' + option}
                data-testid={'publish-target-' + option}
                value={option}
                checked={target === option}
                disabled={optionDisabled}
                onChange={() => setTarget(option)}
              />
              <label htmlFor={'publish-target-' + option}>{option}</label>
              {/* Never hidden, always explained: F §7's rule, and a hidden control reads as a
                  broken studio rather than as a permission the user does not have. */}
              {optionCapability.allowed ? null : (
                <span className="rs-muted" data-testid={'publish-target-' + option + '-reason'}>
                  {optionCapability.reason}
                </span>
              )}
              {optionCapability.allowed && !optionLegal ? (
                <span
                  className="rs-muted"
                  data-testid={'publish-target-' + option + '-transition'}
                >
                  cannot transition from {status} to {option}
                </span>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <DiagnosticList
        severity="error"
        diagnostics={errors}
        emptyText={
          compileState === 'compiled'
            ? 'No errors in the last compile.'
            : 'Nothing has been compiled yet, so there are no errors to show.'
        }
      />

      {/* The warning section is ABSENT while errors stand — see the header. */}
      {blocked ? (
        <p className="rs-muted" data-testid="publish-warnings-suppressed">
          Warnings are not shown while errors are outstanding: the next compile may report a
          different set, and an acknowledgement is recorded against the warning it was given for.
        </p>
      ) : (
        <DiagnosticList
          severity="warning"
          diagnostics={warnings}
          acknowledgements={acknowledgements}
          recorded={recordedAcknowledgements}
          disabled={pending}
          onAcknowledge={(key, acknowledged) => {
            setAcknowledgements((current) => {
              const next = new Map(current);
              const existing = next.get(key);
              next.set(key, { acknowledged, note: existing?.note ?? '' });
              return next;
            });
          }}
          onNoteChange={(key, note) => {
            setAcknowledgements((current) => {
              const next = new Map(current);
              const existing = next.get(key);
              next.set(key, { acknowledged: existing?.acknowledged ?? false, note });
              return next;
            });
          }}
          emptyText={
            compileState === 'compiled'
              ? 'No warnings in the last compile.'
              : 'Nothing has been compiled yet, so there are no warnings to acknowledge.'
          }
        />
      )}

      {error === undefined ? null : (
        <p role="alert" data-testid="publish-error" style={{ color: 'var(--rs-danger)' }}>
          {error}
        </p>
      )}

      <footer style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 }}>
        <button
          type="button"
          className="rs-button"
          data-variant="primary"
          data-testid="publish-submit"
          disabled={!publishable}
          onClick={submit}
        >
          Publish to {target}
        </button>
        <span className="rs-muted" data-testid="publish-blocked-reason">
          {publishReason({
            blocked,
            errorCount: errors.length,
            outstanding: outstanding.length,
            capabilityReason: capability.reason,
            transitionLegal,
            status,
            target,
            pending,
          })}
        </span>
      </footer>

      {/* M0.4's component, driven by the job id the publish endpoint returned. */}
      {job === null ? null : (
        <JobStatus kind={job.kind} status={job.status} progress={job.progress} />
      )}
    </section>
  );
}

/**
 * `compile_state` and an empty diagnostic list are not the same fact, which is why the diagnostics
 * endpoint ships the state alongside the array (K §3). An empty list on `none` means nothing has
 * been compiled; showing a green tick for it is exactly the inference that endpoint's header warns
 * about.
 */
/*
 * The note above the diagnostics, and why its wording changed.
 *
 * It used to end "The diagnostics below are from that compile", which is true and reads as though
 * the list is current. It is not: `compile_diagnostics` is whatever the last compile stored, and it
 * survives every subsequent edit untouched. That cost three separate round-trips in one session —
 * a survey's labels were repaired, the pane kept showing the errors from a compile 24 minutes
 * earlier, and it looked as though the repair had not worked.
 *
 * The copy now names the risk. The better fix is DETECTION rather than a warning: store the
 * version's `revision` alongside the diagnostics, so a client can say "these describe revision 12,
 * you are on 19" and offer to re-run. That needs a column and the compile job writing it, which is
 * a migration rather than a string — worth doing, and deliberately not smuggled into a copy change.
 */
function CompileStateNote({
  compileState,
  diagnosticCount,
}: {
  readonly compileState: CompileState;
  readonly diagnosticCount: number;
}): React.JSX.Element | null {
  if (compileState === 'compiled' || compileState === 'compiling') return null;
  return (
    <p data-testid="publish-compile-state-note">
      {compileState === 'none'
        ? 'This version has never been compiled. Publishing runs the compiler, and the gate may ' +
          'report errors this list cannot show yet.'
        : 'The last compile failed' +
          (diagnosticCount === 0
            ? ' and recorded no diagnostics, which means it did not reach the gate. Publishing runs it again.'
            : '. The diagnostics below are from THAT compile and may predate your most recent ' +
              'edits — publish again to refresh them.')}
    </p>
  );
}

interface ReasonInput {
  readonly blocked: boolean;
  readonly errorCount: number;
  readonly outstanding: number;
  readonly capabilityReason: string | null;
  readonly transitionLegal: boolean;
  readonly status: VersionStatus;
  readonly target: PublishTarget;
  readonly pending: boolean;
}

/**
 * One sentence next to the button, in refusal order: capability, transition, errors, signatures.
 * Ordered most-permanent-first, so a user without the role is not told to go fix warnings they
 * could not publish over anyway.
 */
function publishReason(input: ReasonInput): string {
  if (input.capabilityReason !== null) return input.capabilityReason;
  if (!input.transitionLegal) {
    return `cannot transition from ${input.status} to ${input.target}`;
  }
  // Deliberately no `blocked` branch: stored errors no longer disable the button, so naming them
  // as the reason it is disabled would be false. They are rendered in the error list above, where
  // they belong.
  // Only while the warnings are visible. Naming an unacknowledged warning as the blocking reason
  // while the section is suppressed tells the author to do something the UI will not let them do.
  if (!input.blocked && input.outstanding > 0) {
    return `${String(input.outstanding)} warning(s) still to acknowledge`;
  }
  if (input.pending) return 'queueing…';
  return '';
}
