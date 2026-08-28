/**
 * Webhook management — API §2.16, migration 0020, roadmap P2-10's Frontend line ("Webhook
 * management with a delivery log and replay").
 *
 * ## What makes this screen different from the other editors
 *
 * A webhook subscription is the only authoring object that sends data OUT. So the screen has two
 * halves with opposite jobs: configuration, where the dangerous states must be hard to reach, and
 * the delivery log, where the operator's question is "did it arrive" and the answer has to
 * distinguish four outcomes that look alike.
 *
 * ## The secret is shown ONCE, and the screen has to say so
 *
 * 0020 column-REVOKEs `secret` from `authoring`, so the API can create and rotate a subscription
 * and can never read the key back. That makes "shown once at creation" an enforced property rather
 * than a UI convention — but only if the UI tells the operator, because a key they did not copy is
 * a subscription they must rotate to use. `newSecret` is rendered with that warning and nothing
 * else on the screen can retrieve it.
 *
 * ## `blocked` is not `failed`
 *
 * 0020 keeps them as separate statuses on purpose: a failure is the receiver's server misbehaving
 * and is retried, while `blocked` is OUR refusal to make the request at all — a URL that resolves to
 * a private address, a disabled subscription. Collapsing them would make an SSRF attempt look like a
 * flaky endpoint in this table, which is precisely the confusion the two statuses exist to prevent.
 * So the log renders them differently and explains the difference where an operator reads it.
 *
 * ## Replay does not reset the attempt count
 *
 * `app.webhook_requeue` deliberately leaves `attempts` alone, because zeroing it would erase the
 * evidence that an endpoint has failed eleven times — the only number that distinguishes a broken
 * endpoint from a briefly unlucky one. The button says "Replay", the count stays, and the screen
 * shows it.
 */

'use client';

import { useState } from 'react';

/** 0020's `app.webhook_event`. A deliberate coarsening of the disposition registry, not a mirror. */
export const WEBHOOK_EVENTS = [
  'session.completed',
  'session.screenout',
  'session.quota_full',
  'session.terminated',
  'session.abandoned',
  'version.published',
  'export.ready',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'blocked';

export interface WebhookSubscription {
  readonly id: string;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly enabled: boolean;
  readonly description: string;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly event: string;
  readonly event_key: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly response_status: number | null;
  readonly error: string | null;
  readonly last_attempt_at: string | null;
}

export interface WebhookManagerProps {
  readonly subscriptions: readonly WebhookSubscription[];
  readonly deliveries: readonly WebhookDelivery[];
  readonly onSaveSubscription: (s: WebhookSubscription) => void;
  readonly onReplay: (deliveryId: string) => void;
  /**
   * The signing key, present ONLY on the response that created or rotated a subscription.
   *
   * 0020 column-revokes `secret` from `authoring`, so this is the one moment it can be shown. The
   * screen therefore has to say so — a key nobody copied is a subscription that must be rotated.
   */
  readonly newSecret?: { readonly subscriptionId: string; readonly secret: string } | undefined;
  readonly disabled?: boolean;
  readonly errors?: Readonly<Record<string, string>>;
}

/** 0020's URL CHECKs, mirrored so the refusal arrives before the round trip. */
export function subscriptionProblems(s: WebhookSubscription): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  let parsed: URL | null = null;
  try {
    parsed = new URL(s.url);
  } catch {
    parsed = null;
  }

  if (parsed === null) {
    out['url'] = 'Not a URL.';
  } else if (parsed.protocol !== 'https:') {
    out['url'] =
      'Must be https. An integration is not a reason to send completion data in clear text.';
  } else if (parsed.username !== '' || parsed.password !== '') {
    // `https://metadata@evil.example/` is a URL whose host most readers get wrong.
    out['url'] =
      'Remove the credentials from the URL. A credential in a stored URL is a credential in every ' +
      'log line that prints it, and the host is not what it appears to be.';
  } else if (/^\[?[0-9a-fA-F:.]+\]?$/.test(parsed.hostname)) {
    out['url'] =
      'Use a hostname, not an IP address. A bare address is how the private ranges get reached ' +
      'with no DNS record for anybody to audit.';
  }

  if (s.events.length === 0) {
    out['events'] = 'Choose at least one event — a subscription with none looks configured and ' +
      'receives nothing.';
  }
  return out;
}

/** The four outcomes, in the words an operator needs rather than a status name. */
function explain(d: WebhookDelivery): string {
  switch (d.status) {
    case 'delivered':
      return `delivered (HTTP ${String(d.response_status ?? 0)})`;
    case 'pending':
      return d.attempts === 0 ? 'not attempted yet' : `retrying (attempt ${String(d.attempts)})`;
    case 'failed':
      return `the receiver failed: ${d.error ?? 'no detail'} — retried automatically`;
    case 'blocked':
      // The distinction 0020 keeps two statuses for. An operator reading "failed" here would go and
      // check their endpoint, which is not the problem.
      return `WE refused to send this: ${d.error ?? 'no detail'} — not retried`;
  }
}

export function WebhookManager({
  subscriptions,
  deliveries,
  onSaveSubscription,
  onReplay,
  newSecret,
  disabled = false,
  errors = {},
}: WebhookManagerProps): React.JSX.Element {
  const [editing, setEditing] = useState<WebhookSubscription | null>(null);
  const local = editing === null ? {} : subscriptionProblems(editing);
  const shown: Readonly<Record<string, string>> = { ...local, ...errors };

  return (
    <section aria-label="Webhooks">
      {newSecret !== undefined && (
        <div role="alert">
          <p>
            {'Copy this signing key now — it is shown once and cannot be retrieved. The API can ' +
              'create and rotate a subscription and can never read its key back, which is what ' +
              'makes that guarantee real rather than a convention.'}
          </p>
          <code aria-label="New signing key">{newSecret.secret}</code>
        </div>
      )}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {subscriptions.map((s) => (
          <li key={s.id} style={{ border: '1px solid #c9c9c9', padding: 8, marginBottom: 8 }}>
            <span>{s.url}</span>
            <span>{s.enabled ? ' (enabled)' : ' (disabled)'}</span>
            <span>{` — ${s.events.join(', ')}`}</span>
            <button type="button" disabled={disabled} onClick={() => setEditing(s)}>
              {`Edit ${s.url}`}
            </button>
          </li>
        ))}
      </ul>

      {editing !== null && (
        <fieldset>
          <legend>Subscription</legend>
          <label>
            Endpoint URL
            <input
              aria-label="Endpoint URL"
              value={editing.url}
              disabled={disabled}
              onChange={(e) => setEditing({ ...editing, url: e.target.value })}
            />
          </label>
          {shown['url'] !== undefined && <p role="alert">{shown['url']}</p>}

          <fieldset>
            <legend>Events</legend>
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev}>
                <input
                  type="checkbox"
                  aria-label={ev}
                  checked={editing.events.includes(ev)}
                  disabled={disabled}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      events: e.target.checked
                        ? [...editing.events, ev]
                        : editing.events.filter((x) => x !== ev),
                    })
                  }
                />
                {` ${ev}`}
              </label>
            ))}
          </fieldset>
          {shown['events'] !== undefined && <p role="alert">{shown['events']}</p>}

          <label>
            <input
              type="checkbox"
              aria-label="Enabled"
              checked={editing.enabled}
              disabled={disabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            {' Enabled'}
          </label>

          <button
            type="button"
            disabled={disabled || Object.keys(local).length > 0}
            onClick={() => onSaveSubscription(editing)}
          >
            Save subscription
          </button>
        </fieldset>
      )}

      <h3>Delivery log</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Outcome</th>
            <th scope="col">Attempts</th>
            <th scope="col">Replay</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td>{d.event}</td>
              <td>{explain(d)}</td>
              {/* The attempt count is on screen because `app.webhook_requeue` deliberately does not
                  reset it: it is the only number that distinguishes a broken endpoint from a briefly
                  unlucky one. */}
              <td aria-label={`${d.event_key} attempts`}>{d.attempts}</td>
              <td>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onReplay(d.id)}
                >
                  {`Replay ${d.event_key}`}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {deliveries.length === 0 && <p>No deliveries yet.</p>}
    </section>
  );
}
