/**
 * The Postgres `WebhookStore` — four RPC calls, no SQL of its own beyond them.
 *
 * Every statement here is a call to a function 0020 defines, and that is the point rather than an
 * accident of style. The interesting rules — no org parameter (B §2), the claim lease, the
 * `ON CONFLICT` idempotency, the cross-org NOT FOUND — live in the database where 0020's 60 pgTAP
 * assertions exercise them. A store that reimplemented any of that in TypeScript would be a second
 * copy of a security rule, which is the thing `@resscript/egress` exists to avoid.
 *
 * ## The connection role
 *
 * Deliberately the connection's own role, with no `SET LOCAL ROLE`. apps/worker downshifts to
 * `authoring` with a user's claims when it acts ON A USER'S BEHALF (publish-store.ts' `asUser`), and
 * webhook delivery acts on nobody's behalf — it is system machinery draining a queue. 0020 asserts
 * the matching posture: neither `authoring` nor `runtime_writer` can execute these functions.
 */

import { Pool, type PoolClient } from 'pg';

import type { DeliveryRequest } from './deliver.js';
import type { WebhookStore } from '../kinds/webhook.js';

const SQL = {
  dispatch: 'SELECT app.webhook_dispatch_batch($1::integer) AS created',
  claim:
    'SELECT delivery_id, webhook_id, url, secret, event, event_key, payload, attempts ' +
    'FROM app.webhook_claim($1::text)',
  record: 'SELECT app.webhook_record_attempt($1, $2::app.webhook_delivery_status, $3, $4, $5)',
  requeue: 'SELECT app.webhook_requeue($1, $2::integer)',
} as const;

export interface PgWebhookStoreOptions {
  readonly databaseUrl: string;
  readonly max?: number;
}

export function createPgWebhookStore(options: PgWebhookStoreOptions): WebhookStore & {
  close(): Promise<void>;
} {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    // Two connections is enough and the cap is deliberate: the unit of work is ONE delivery, so a
    // large pool would only let this worker open more sockets to a receiver that is already slow.
    max: options.max ?? 2,
  });

  const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };

  return {
    async dispatch(limit: number): Promise<number> {
      return withClient(async (client) => {
        const res = await client.query<{ created: number }>(SQL.dispatch, [limit]);
        return Number(res.rows[0]?.created ?? 0);
      });
    },

    async claim(worker: string): Promise<DeliveryRequest | null> {
      return withClient(async (client) => {
        const res = await client.query<{
          delivery_id: string;
          url: string;
          secret: string;
          event: string;
          event_key: string;
          payload: unknown;
          attempts: number;
        }>(SQL.claim, [worker]);
        const row = res.rows[0];
        if (row === undefined) return null;
        return {
          deliveryId: row.delivery_id,
          url: row.url,
          secret: row.secret,
          event: row.event,
          eventKey: row.event_key,
          payload: row.payload,
          attempts: Number(row.attempts),
        };
      });
    },

    async recordAttempt(
      deliveryId: string,
      status: 'delivered' | 'failed' | 'blocked',
      responseStatus: number | null,
      body: string | null,
      error: string | null,
    ): Promise<void> {
      await withClient(async (client) => {
        await client.query(SQL.record, [deliveryId, status, responseStatus, body, error]);
      });
    },

    async requeue(deliveryId: string, delaySeconds: number): Promise<void> {
      await withClient(async (client) => {
        await client.query(SQL.requeue, [deliveryId, Math.max(0, Math.round(delaySeconds))]);
      });
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
