/**
 * The `:id`-in-the-path guard.
 *
 * `/api/v1/organizations/:id` names an org in its URL, which looks like the very thing this
 * codebase forbids. It is not: the segment is a CHECK, not a selector. The handler never reads
 * data for the org the path names — it reads the ACTIVE org from the token and refuses the
 * request when the two disagree. Reading `:id` instead would be the `?org_id=` hole in a
 * different syntax.
 *
 * Lives here rather than in a route file because a Next route module should export HTTP methods
 * and nothing else.
 */

import { AppError } from '@resscript/observability';

export function assertPathOrgMatchesToken(pathOrgId: string, activeOrgId: string | null): void {
  if (activeOrgId === null || pathOrgId !== activeOrgId) {
    // 404 and not 403: security §2.2 keeps org authority in the token, and API §1.5 makes a
    // cross-tenant read a 404 because confirming existence is itself the information leak.
    throw new AppError('not_found', 'organization not found', { context: { path_org: pathOrgId } });
  }
}
