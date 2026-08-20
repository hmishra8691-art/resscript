/**
 * The route wrapper: context resolution, error rendering, request-id propagation.
 *
 * Every handler under `src/app/api/v1` goes through `route()`, which is what makes three
 * things true everywhere instead of per-file: the error envelope is the one from
 * `@resscript/observability`, `request_id` is on the response AND in every log line for the
 * request, and the handler is a plain function of `(ctx, req, params)` — so a test calls it
 * directly with an in-memory context.
 */

import type { ZodType, ZodIssue } from 'zod';
import { AppError } from '@resscript/observability';
import type { JsonValue } from '@resscript/schema';
import { resolveRequestContext, type RequestContext } from '../context.js';
import { errorResponse, REQUEST_ID_HEADER } from './respond.js';

export type RouteHandler<P> = (
  ctx: RequestContext,
  req: Request,
  params: P,
) => Promise<Response> | Response;

/**
 * Next 15 passes route params as a Promise. Awaiting it inside the wrapper keeps every handler
 * free of that detail, and keeps the handler callable from a test with a plain object.
 */
export interface NextRouteArgs<P> {
  readonly params: Promise<P>;
}

export function route<P extends Record<string, string> = Record<string, never>>(
  handler: RouteHandler<P>,
): (req: Request, args?: NextRouteArgs<P>) => Promise<Response> {
  return async (req: Request, args?: NextRouteArgs<P>): Promise<Response> => {
    let ctx: RequestContext | undefined;
    try {
      ctx = await resolveRequestContext(req);
      const params = args === undefined ? ({} as P) : await args.params;
      const response = await handler(ctx, req, params);
      if (!response.headers.has(REQUEST_ID_HEADER)) {
        response.headers.set(REQUEST_ID_HEADER, ctx.requestId);
      }
      return response;
    } catch (err: unknown) {
      // A failure DURING context resolution still has to answer in the envelope; without a
      // context there is no request id to correlate on, so one is minted for the response.
      const requestId = ctx?.requestId ?? 'req_unresolved';
      return errorResponse(err, ctx === undefined ? { requestId } : { requestId, logger: ctx.logger });
    }
  };
}

function detailFor(issue: ZodIssue): { path: string; code: string; message: string } {
  return {
    // Dotted path into the REQUEST body, so a client can attach the message to the field the
    // user typed in (API §1.5).
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  };
}

/**
 * Parse and validate a JSON body.
 *
 * Unknown fields are REJECTED with `400 unknown_field`, not ignored (API §1.1). Ignoring them
 * means a client typo silently does nothing, and in this product that is a survey that quietly
 * lacks a quota. Every schema passed here must therefore be `.strict()`.
 *
 * Returns the raw parsed JSON alongside the validated value because the idempotency layer
 * hashes the raw body: hashing the post-validation object would make two requests that differ
 * only in a field we defaulted look identical.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<{ value: T; raw: JsonValue }> {
  const text = await req.text();
  let raw: JsonValue;
  if (text.trim() === '') {
    raw = {};
  } else {
    try {
      raw = JSON.parse(text) as JsonValue;
    } catch {
      throw new AppError('malformed_request', 'the request body is not valid JSON');
    }
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    const unknownKeys = issues.filter((i) => i.code === 'unrecognized_keys');
    if (unknownKeys.length > 0) {
      throw new AppError('unknown_field', 'the request body contains unknown fields', {
        details: unknownKeys.flatMap((issue) =>
          (issue.code === 'unrecognized_keys' ? issue.keys : []).map((key) => ({
            path: [...issue.path, key].join('.'),
            code: 'unknown_field',
            message: `${key} is not a field of this resource`,
          })),
        ),
      });
    }
    throw new AppError(
      'validation_failed',
      `${issues.length} field${issues.length === 1 ? '' : 's'} failed validation`,
      { details: issues.map(detailFor) },
    );
  }
  return { value: result.data, raw };
}

/**
 * The active org, or a 403.
 *
 * A user with no `active_org_id` is a legitimate state — they have just signed up and belong to
 * nothing — so this is not an internal error. Every data route needs the org, and the UI's
 * answer to this 403 is the "create an organization" screen.
 */
export function requireActiveOrg(ctx: RequestContext): string {
  const org = ctx.claims.activeOrgId;
  if (org === null) {
    throw new AppError('forbidden', 'no active organization; create or join one first', {
      details: [{ path: null, code: 'no_active_org', message: 'POST /api/v1/organizations' }],
    });
  }
  return org;
}
