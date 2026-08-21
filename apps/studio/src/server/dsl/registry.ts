/**
 * `content.*` rows → the DSL's registry.
 *
 * This is the studio-side twin of what `packages/compiler` (P1-08) will do from a `Survey`
 * document: build the type environment D §3.2 makes the checker's only parameter. It lives in one
 * file for the reason the repository seam exists — the mapping from column to declaration happens
 * once, so "why does this rule not type-check" is a question about this file rather than about
 * three routes.
 *
 * ## Enum domain identity, and the gap it exposes
 *
 * D §2.2 makes enum domains **nominal**: `Q3 = Q4` across two option lists is `LGC-T007` even when
 * the codes coincide, and that check is the one that catches a copy-pasted rule. Identity therefore
 * has to come from somewhere, and `content.variables.enum_domain` is a *per-variable copy* of
 * `[{code, label_key}]` with no id of its own. So a domain id is synthesized from the emitting
 * question (`dom_<question id>`), which is exactly what D §3.2 prescribes: "each option-bearing
 * question gets a `DomainId` derived from its question id".
 *
 * The consequence is a real and documented limitation: D §3.2 also says "a shared option list (a
 * template brand list) gets one shared domain explicitly, via the template reference", and no
 * column in 0007 records that reference. Two questions built from the same template therefore get
 * two domains here, and a legitimate `MASK Q10 OPTIONS TO SELECTED IN Q5` across them reports
 * `LGC-T021`. Reported rather than papered over: the honest fix is a `content.option_lists` (or an
 * `enum_domain_id` column), not a heuristic that guesses two option lists are "the same" because
 * their codes match — which would silently *admit* the cross-domain comparison this check exists
 * to reject.
 *
 * ## Ordinality
 *
 * `EnumDomain.ordinal` defaults to `false` (nominal), matching `buildTypeEnv`. 0007 has no ordinal
 * column and D §11 note 2 already records that gap. The consequence is that `Q9 > 3` on a Likert
 * scale is rejected with `LGC-T009` until the question-type plugin's declaration supplies it
 * (F §6). That is the safe direction — the unsound one ships the top-2-box bug — but it *is* a
 * false positive on a real pattern, and it is the first thing to fix when the plugin declaration
 * lands.
 */

import type {
  BlockDecl,
  BlockId,
  DomainId,
  EnumDomain,
  ItemDecl,
  LogicRegistryInput,
  PageDecl,
  PageId,
  QuestionDecl,
  QuestionId,
  VarDecl,
  VariableId,
} from '@resscript/logic';
import {
  asBlockId,
  asDomainId,
  asOptionId,
  asPageId,
  asQuestionId,
  asVariableId,
} from '@resscript/logic';
import { dslRegistry, type DslRegistry, type NodeIndex } from '@resscript/rescript-dsl';
import type {
  RegistryItemRow,
  RegistryNodeRow,
  RegistryVariableRow,
  VersionRegistryRows,
} from '@/server/repo/types';

export function toLogicRegistryInput(rows: VersionRegistryRows): LogicRegistryInput {
  const itemsByQuestion = new Map<string, RegistryItemRow[]>();
  for (const item of rows.items) {
    const list = itemsByQuestion.get(item.question_id) ?? [];
    list.push(item);
    itemsByQuestion.set(item.question_id, list);
  }
  /** item id → the variable that item fans out to, so `ItemDecl.variable_id` can be filled. */
  const variableByItem = new Map<string, string>();
  for (const variable of rows.variables) {
    if (variable.source_item_id !== null) variableByItem.set(variable.source_item_id, variable.id);
  }
  const codeByItem = new Map<string, number>(rows.items.map((item) => [item.id, item.code]));

  const domains = new Map<DomainId, { readonly entries: Map<number, string>; readonly id: DomainId }>();
  const domainOfQuestion = new Map<string, DomainId>();

  const variables: VarDecl[] = rows.variables.map((row): VarDecl => {
    const domain = domainIdFor(row);
    if (domain !== undefined) {
      const bucket = domains.get(domain) ?? { id: domain, entries: new Map<number, string>() };
      for (const entry of row.enum_domain ?? []) {
        if (!bucket.entries.has(entry.code)) bucket.entries.set(entry.code, entry.label_key);
      }
      domains.set(domain, bucket);
      if (row.source_question_id !== null) domainOfQuestion.set(row.source_question_id, domain);
    }
    const part = partKindOf(row);
    const code = row.source_item_id === null ? undefined : codeByItem.get(row.source_item_id);
    return {
      id: asVariableId(row.id),
      name: row.name,
      kind: row.kind,
      type: row.vtype,
      persist: row.persist,
      pii: row.pii,
      ...(domain === undefined ? {} : { domain }),
      ...(row.source_question_id === null ? {} : { question_id: asQuestionId(row.source_question_id) }),
      ...(part === undefined ? {} : { part }),
      ...(code === undefined ? {} : { code }),
      ...(row.source_item_id === null ? {} : { option_id: asOptionId(row.source_item_id) }),
      // `expression` is deliberately absent. It is only read when checking a *derived variable's
      // own definition*, which is the compiler's job (P1-08); these endpoints check the author's
      // source, where a derived variable appears as a typed leaf. Shipping every derived AST to
      // satisfy a field nothing here reads would double the payload of a per-keystroke request.
    };
  });

  const nodesById = new Map<string, RegistryNodeRow>(rows.nodes.map((node) => [node.id, node]));
  const questions: QuestionDecl[] = [];
  const pages: PageDecl[] = [];
  const blocks: BlockDecl[] = [];

  for (const node of rows.nodes) {
    switch (node.node_kind) {
      case 'question': {
        if (node.ref === null) continue; // `nodes_kind_shape` makes this unreachable; typed anyway.
        const items = itemsByQuestion.get(node.id) ?? [];
        const domain = domainOfQuestion.get(node.id);
        questions.push({
          id: asQuestionId(node.id),
          ref: node.ref,
          required: node.required ?? false,
          options: itemDecls(items, 'option', variableByItem),
          rows: itemDecls(items, 'row', variableByItem),
          columns: itemDecls(items, 'column', variableByItem),
          emits: node.emits.map((id): VariableId => asVariableId(id)),
          ...(domain === undefined ? {} : { domain }),
          ...(node.parent_id !== null && nodesById.get(node.parent_id)?.node_kind === 'page'
            ? { page_id: asPageId(node.parent_id) }
            : {}),
        });
        break;
      }
      case 'page':
        pages.push({
          id: asPageId(node.id),
          question_ids: childrenOf(rows.nodes, node.id, 'question').map((child): QuestionId => asQuestionId(child.id)),
          ...(node.parent_id !== null && nodesById.get(node.parent_id)?.node_kind === 'block'
            ? { block_id: asBlockId(node.parent_id) }
            : {}),
        });
        break;
      case 'block':
        blocks.push({
          id: asBlockId(node.id),
          page_ids: childrenOf(rows.nodes, node.id, 'page').map((child): PageId => asPageId(child.id)),
        });
        break;
      default:
        // `text` nodes emit nothing and are not referenceable from logic.
        break;
    }
  }

  const domainDecls: EnumDomain[] = [...domains.values()].map((bucket) => ({
    id: bucket.id,
    entries: [...bucket.entries.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([code, label_key]) => ({ code, label_key })),
    // See the header: no ordinal column exists yet, and nominal is the safe default.
    ordinal: false,
  }));

  return { variables, domains: domainDecls, questions, pages, blocks };
}

/**
 * The `NodeIndex` `packages/rescript-dsl` cannot build for itself (its registry.ts explains why
 * `PageDecl`/`BlockDecl` carry no ref). Supplying it is what turns `SKIP TO P7` from an
 * `RSL-0012` warning into a resolved page id.
 */
export function toNodeIndex(rows: VersionRegistryRows): NodeIndex {
  const byRef = (kind: RegistryNodeRow['node_kind']): Map<string, string> =>
    new Map(
      rows.nodes
        .filter((node) => node.node_kind === kind && node.ref !== null)
        .map((node) => [node.ref as string, node.id]),
    );
  const questions = byRef('question');
  const pages = byRef('page');
  const blocks = byRef('block');
  const reverse = (map: Map<string, string>): Map<string, string> =>
    new Map([...map.entries()].map(([ref, id]) => [id, ref]));
  const questionRefs = reverse(questions);
  const pageRefs = reverse(pages);
  const blockRefs = reverse(blocks);

  return {
    questionByRef: (ref) => {
      const id = questions.get(ref);
      return id === undefined ? undefined : asQuestionId(id);
    },
    pageByRef: (ref) => {
      const id = pages.get(ref);
      return id === undefined ? undefined : asPageId(id);
    },
    blockByRef: (ref) => {
      const id = blocks.get(ref);
      return id === undefined ? undefined : asBlockId(id);
    },
    refOfQuestion: (id: QuestionId) => questionRefs.get(id),
    refOfPage: (id: PageId) => pageRefs.get(id),
    refOfBlock: (id: BlockId) => blockRefs.get(id),
  };
}

export function toDslRegistry(rows: VersionRegistryRows): DslRegistry {
  return dslRegistry(toLogicRegistryInput(rows), toNodeIndex(rows));
}

function itemDecls(
  items: readonly RegistryItemRow[],
  kind: RegistryItemRow['item_kind'],
  variableByItem: ReadonlyMap<string, string>,
): readonly ItemDecl[] {
  return items
    .filter((item) => item.item_kind === kind)
    .map((item, index): ItemDecl => {
      const variable = variableByItem.get(item.id);
      return {
        option_id: asOptionId(item.id),
        code: item.code,
        label_key: item.label_key ?? '',
        // Canonical position, not display order: `sort_key` ordered the rows, and display order
        // comes from the randomizer at runtime (D §2.6).
        position: index,
        ref: item.ref,
        ...(variable === undefined ? {} : { variable_id: asVariableId(variable) }),
      };
    });
}

function childrenOf(
  nodes: readonly RegistryNodeRow[],
  parentId: string,
  kind: RegistryNodeRow['node_kind'],
): readonly RegistryNodeRow[] {
  return nodes.filter((node) => node.parent_id === parentId && node.node_kind === kind);
}

function domainIdFor(row: RegistryVariableRow): DomainId | undefined {
  if (row.vtype !== 'enum' && row.vtype !== 'set') return undefined;
  // A variable with no emitting question (a hidden enum, a quota dimension) gets a domain of its
  // own. That is nominally correct and slightly stricter than ideal: two hidden enums with the
  // same codes are not comparable. `CODE()` is the documented escape (D §3.2).
  return asDomainId(`dom_${row.source_question_id ?? row.id}`);
}

function partKindOf(row: RegistryVariableRow): VarDecl['part'] | undefined {
  const kind = row.source_part === null ? undefined : row.source_part['kind'];
  return typeof kind === 'string' ? (kind as VarDecl['part']) : undefined;
}
