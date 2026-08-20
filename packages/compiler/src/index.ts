/**
 * @resscript/compiler — reserved for milestone P1-08.
 *
 * Authoring model to compiled artifact, plus the static validation gate. Deliverable C 17.
 *
 * This placeholder exists so `tsc -b` can build the workspace project graph before the
 * package has content: TypeScript treats a composite project with no input files as error
 * TS18003, which would break the root build for every other package. Delete it when P1-08
 * lands.
 */
export const MILESTONE = 'P1-08' as const;
