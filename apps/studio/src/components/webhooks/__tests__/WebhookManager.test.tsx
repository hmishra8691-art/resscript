/**
 * Webhook management tests.
 *
 * A webhook subscription is the only authoring object that sends data OUT, so the assertions worth
 * making are:
 *
 *  - the signing key is shown ONCE with that stated, because 0020 column-revokes `secret` from
 *    `authoring` — the API can rotate a key and can never read one back, which makes "shown once"
 *    enforced rather than a convention, but only if the operator is told;
 *  - `blocked` reads differently from `failed`, because 0020 keeps them separate on purpose: one is
 *    the receiver misbehaving and one is OUR refusal, and collapsing them makes an SSRF attempt look
 *    like a flaky endpoint;
 *  - the attempt count is visible, because `app.webhook_requeue` deliberately does not reset it —
 *    it is the only number distinguishing a broken endpoint from a briefly unlucky one;
 *  - 0020's URL refusals arrive before the round trip.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  subscriptionProblems,
  WebhookManager,
  type WebhookDelivery,
  type WebhookSubscription,
} from '@/components/webhooks/WebhookManager';

afterEach(cleanup);

function sub(over: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'whk_1',
    url: 'https://hooks.acme.example/resscript',
    events: ['session.completed'],
    enabled: true,
    description: '',
    ...over,
  };
}

function delivery(over: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'whd_1',
    event: 'session.completed',
    event_key: 'ses_1:COMPLETE',
    status: 'delivered',
    attempts: 1,
    response_status: 200,
    error: null,
    last_attempt_at: '2026-08-28T00:00:00.000Z',
    ...over,
  };
}

function setup(props: Record<string, unknown> = {}) {
  const onSaveSubscription = vi.fn();
  const onReplay = vi.fn();
  render(
    <WebhookManager
      subscriptions={[sub()]}
      deliveries={[delivery()]}
      onSaveSubscription={onSaveSubscription}
      onReplay={onReplay}
      {...props}
    />,
  );
  return { onSaveSubscription, onReplay };
}

/* ---------------------------------------------------------------- *
 * The secret, shown once
 * ---------------------------------------------------------------- */

describe('the signing key', () => {
  it('is shown with the warning that it cannot be retrieved', () => {
    // 0020 column-revokes `secret` from `authoring`. That makes "shown once at creation" an enforced
    // property — but a key the operator did not copy is a subscription they must rotate to use, so
    // the screen has to say so.
    setup({ newSecret: { subscriptionId: 'whk_1', secret: 'a'.repeat(44) } });
    expect(screen.getByLabelText('New signing key').textContent).toBe('a'.repeat(44));
    expect(screen.getByRole('alert').textContent).toContain('shown once and cannot be retrieved');
  });

  it('is absent when the API did not just mint one', () => {
    // There is no other way to obtain it: nothing else on this screen can retrieve a key.
    setup();
    expect(screen.queryByLabelText('New signing key')).toBeNull();
  });
});

/* ---------------------------------------------------------------- *
 * blocked is not failed
 * ---------------------------------------------------------------- */

describe('the delivery log', () => {
  it('says WE refused for a blocked delivery, not that it failed', () => {
    // The distinction 0020 keeps two statuses for. An operator reading "failed" here would go and
    // check their endpoint, which is not the problem.
    setup({
      deliveries: [
        delivery({
          status: 'blocked',
          response_status: 0,
          error: 'hooks.acme.example resolves to 169.254.169.254',
        }),
      ],
    });
    const row = screen.getByText(/WE refused to send this/);
    expect(row.textContent).toContain('169.254.169.254');
    expect(row.textContent).toContain('not retried');
  });

  it('says the RECEIVER failed for a failed delivery, and that it is retried', () => {
    setup({ deliveries: [delivery({ status: 'failed', response_status: 503, error: 'HTTP 503' })] });
    const row = screen.getByText(/the receiver failed/);
    expect(row.textContent).toContain('retried automatically');
  });

  it('distinguishes never-attempted from retrying', () => {
    // `response_status = 0` and `NULL` mean different things in 0020 — no status versus no attempt —
    // and they read identically in a naive table.
    setup({ deliveries: [delivery({ status: 'pending', attempts: 0, response_status: null })] });
    expect(screen.getByText('not attempted yet')).toBeTruthy();

    cleanup();
    setup({ deliveries: [delivery({ status: 'pending', attempts: 4, response_status: null })] });
    expect(screen.getByText(/retrying \(attempt 4\)/)).toBeTruthy();
  });

  it('shows the attempt count, which replay deliberately does not reset', () => {
    // `app.webhook_requeue` leaves `attempts` alone: zeroing it would erase the evidence that an
    // endpoint has failed eleven times, which is the only number distinguishing broken from
    // briefly unlucky.
    setup({ deliveries: [delivery({ status: 'failed', attempts: 11, error: 'HTTP 500' })] });
    expect(screen.getByLabelText('ses_1:COMPLETE attempts').textContent).toBe('11');
  });

  it('replays one delivery by id', async () => {
    const { onReplay } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Replay ses_1:COMPLETE' }));
    expect(onReplay).toHaveBeenCalledWith('whd_1');
  });

  it('says so when there are no deliveries, rather than rendering an empty table', () => {
    setup({ deliveries: [] });
    expect(screen.getByText('No deliveries yet.')).toBeTruthy();
  });
});

/* ---------------------------------------------------------------- *
 * 0020's URL refusals, before the round trip
 * ---------------------------------------------------------------- */

describe('subscriptionProblems', () => {
  it('accepts a plain https endpoint', () => {
    expect(subscriptionProblems(sub())).toEqual({});
  });

  it('refuses http', () => {
    expect(subscriptionProblems(sub({ url: 'http://hooks.acme.example/x' }))['url']).toMatch(
      /clear text/,
    );
  });

  it('refuses credentials in the URL, and explains the host is not what it appears', () => {
    // `https://metadata@evil.example/` is a URL whose host most readers get wrong.
    const p = subscriptionProblems(sub({ url: 'https://user:pw@hooks.acme.example/x' }));
    expect(p['url']).toMatch(/not what it appears/);
  });

  it('refuses a bare IP address', () => {
    for (const url of ['https://169.254.169.254/x', 'https://10.0.0.1/']) {
      expect(subscriptionProblems(sub({ url }))['url']).toMatch(/hostname, not an IP/);
    }
  });

  it('refuses an empty event list', () => {
    expect(subscriptionProblems(sub({ events: [] }))['events']).toMatch(/receives nothing/);
  });

  it('refuses a non-URL', () => {
    expect(subscriptionProblems(sub({ url: 'not a url' }))['url']).toBe('Not a URL.');
  });
});

describe('editing a subscription', () => {
  it('blocks Save while the URL is refused', async () => {
    setup();
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit https://hooks.acme.example/resscript' }),
    );
    const field = screen.getByLabelText('Endpoint URL');
    await userEvent.clear(field);
    await userEvent.type(field, 'http://hooks.acme.example/x');

    expect(screen.getByText(/clear text/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save subscription' })).toBeDisabled();
  });

  it('saves a valid edit', async () => {
    const { onSaveSubscription } = setup();
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit https://hooks.acme.example/resscript' }),
    );
    await userEvent.click(screen.getByLabelText('session.screenout'));
    await userEvent.click(screen.getByRole('button', { name: 'Save subscription' }));

    expect(onSaveSubscription).toHaveBeenCalledTimes(1);
    const saved = onSaveSubscription.mock.calls[0]?.[0] as WebhookSubscription;
    expect(saved.events).toContain('session.screenout');
  });

  it('can disable a subscription without deleting it', async () => {
    // A disabled subscription keeps its delivery history, which is the point: "why did this stop"
    // is answerable only if the rows survive.
    const { onSaveSubscription } = setup();
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit https://hooks.acme.example/resscript' }),
    );
    await userEvent.click(screen.getByLabelText('Enabled'));
    await userEvent.click(screen.getByRole('button', { name: 'Save subscription' }));

    expect((onSaveSubscription.mock.calls[0]?.[0] as WebhookSubscription).enabled).toBe(false);
  });

  it('disables every control when the caller is not permitted', async () => {
    setup({ disabled: true });
    expect(
      screen.getByRole('button', { name: 'Edit https://hooks.acme.example/resscript' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Replay ses_1:COMPLETE' })).toBeDisabled();
  });
});
