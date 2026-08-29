/**
 * Where an artifact's files live — ONE definition, for the writer and the reader.
 *
 * `apps/worker` writes the artifact and `apps/runtime` serves it, and until this file existed each
 * carried its own idea of the layout. They disagreed. The worker wrote
 * `artifact/<hash>/manifest.json`; the runtime's `ARTIFACT_DIR` source read `<hash>/manifest.json`,
 * with no prefix. So on any deployment using a shared directory, EVERY published survey answered
 * 404 for every respondent and every preview — the artifact existed, the database named it
 * correctly, and the runtime looked one directory too shallow.
 *
 * Neither side's tests could see it. The worker's write and read both go through its own store, so
 * they agree with each other whatever the prefix is. The runtime's tests use a loader faked from a
 * map keyed by hash, so the file source's path construction never runs. Two green suites, one
 * unusable seam — the same shape as four other findings in this codebase, and the most expensive,
 * because it breaks the respondent path rather than an authoring one.
 *
 * It lives in `@resscript/schema` because that is the package both apps already depend on, and
 * because the artifact layout is a contract rather than an implementation detail: 03 §17 specifies
 * the tree, and `types/artifact.ts` explains that the compiler's contract belongs here so the
 * runtime can hold to it without depending on the compiler. A storage key is the same kind of
 * shared fact as the shape of `manifest.json`.
 *
 * A separate module rather than an addition to `types/artifact.ts`, which says "types only" at the
 * top and means it.
 */

/**
 * The prefix every artifact file sits under.
 *
 * Hash first WITHIN the prefix, so every file of one artifact shares a path and a bucket listing
 * groups by artifact rather than by page number — which is what lets a lifecycle rule or an
 * object-lock policy be written against one prefix per published version.
 */
export const ARTIFACT_KEY_PREFIX = 'artifact';

/**
 * The storage key for one file of one artifact: `artifact/<hash>/<path>`.
 *
 * Used by the worker to write and by the runtime's file source to read. If you are about to write
 * a path by hand on either side, use this instead — that is the entire reason it exists.
 */
export function artifactKey(hash: string, path: string): string {
  return `${ARTIFACT_KEY_PREFIX}/${hash}/${path}`;
}
