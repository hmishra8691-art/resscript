/**
 * "Can this user publish to production, and if not, what do I put next to the disabled control."
 *
 * WHY THE FLOORS ARE IMPORTED FROM `src/server/publish.ts`. K §1 puts publish-to-production on
 * `project_manager` (50) and publish-to-staging on `programmer` (40), and that asymmetry is the
 * stated reason `app.publish_version` is a `SECURITY DEFINER` function rather than DML. There are
 * therefore already TWO copies of the floors — the migration's `CASE` and `PUBLISH_FLOORS` — and
 * `src/server/publish.ts`'s header says why the second exists: so that "is the API more permissive
 * than the function" is one table to compare against one `CASE`. A third copy in the UI would make
 * that comparison a three-way one, and the UI's copy is the one nobody would notice going stale:
 * the failure mode is not an error, it is a button that looks available and 403s.
 *
 * The import direction is `components/ -> server/` and that is safe here for one specific reason:
 * `server/publish.ts` imports `@resscript/observability` (whose root entry is deliberately free of
 * Node builtins — `node:async_hooks` lives behind the `/node` subpath), `@resscript/schema`, and
 * `./context.js` as a TYPE ONLY, which `verbatimModuleSyntax` erases. Nothing reachable from it
 * touches `next/headers`, the Supabase server client or a Node builtin. If that ever changes, the
 * fix is to move `PUBLISH_FLOORS` into `@resscript/schema` next to `ORG_ROLE_RANKS` — NOT to
 * restate it here.
 *
 * WHAT THIS REFUSES TO DO. It does not hide anything. F §7: "a feature the plan lacks is shown as
 * unavailable, never hidden", and the same argument is stronger for a capability — a programmer who
 * cannot find the production control concludes the studio is broken, whereas one who sees it
 * disabled next to "publishing to production requires the project_manager role (you are
 * programmer)" learns who to ask. `reason` is therefore never `null` when `allowed` is false.
 */

import type { OrgRole } from '@resscript/schema';
import { meetsRole } from '@/server/auth';
import { PUBLISH_FLOORS, ROLLBACK_FLOOR, type PublishTarget } from '@/server/publish';

export type { PublishTarget };

export interface Capability {
  readonly allowed: boolean;
  /** The floor this capability requires, so the UI can name it without re-deriving it. */
  readonly floor: OrgRole;
  /** Rendered next to the disabled control. `null` only when `allowed`. */
  readonly reason: string | null;
}

/** The publish targets, in the order the dialog offers them: least privileged first. */
export const PUBLISH_TARGETS: readonly PublishTarget[] = ['staging', 'production'];

function capability(role: OrgRole | null, floor: OrgRole, action: string): Capability {
  if (meetsRole(role, floor)) return { allowed: true, floor, reason: null };
  return {
    allowed: false,
    floor,
    // Names the required role AND the actual one. `requireRole` puts both in its 403 details for
    // the same reason: "this requires project_manager" alone leaves a user guessing whether they
    // are one.
    reason:
      `${action} requires the ${floor} role or higher` +
      (role === null ? ' (you are not a member of this organization)' : ` (you are ${role})`),
  };
}

export function publishCapability(role: OrgRole | null, target: PublishTarget): Capability {
  return capability(role, PUBLISH_FLOORS[target], `publishing to ${target}`);
}

export function rollbackCapability(role: OrgRole | null): Capability {
  return capability(role, ROLLBACK_FLOOR, 'rolling back');
}
