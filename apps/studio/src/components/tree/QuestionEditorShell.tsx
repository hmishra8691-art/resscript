/**
 * The question editor SHELL — the host the plugin's own editor renders inside (F §6).
 *
 * Studio owns the authoring model; the plugin owns its config UI. The shell's whole job is the
 * seam between those two facts:
 *
 *  1. build the `AuthoredQuestion` the editor expects out of the node body the API returned;
 *  2. take the editor's `patch(ops)` and turn it into `PATCH /nodes/{id}` — through
 *     `translateEditorPatch`, which runs the kit's own path allowlist first;
 *  3. supply an `EditorContext` (`t`, `requestAsset`), because an editor never resolves a
 *     translation or touches storage itself.
 *
 * ## Why the config is defaulted through the plugin
 *
 * `question.config` comes off the wire as whatever is stored, and a first-party editor reads it
 * directly (`question.config.other.enabled`). A node created before a plugin gained a field
 * therefore crashes its editor on a missing member. `defaultConfig` is the plugin's own answer to
 * "what does a fresh one look like", so the shell layers the stored config over it. Shallow, not
 * deep: a stored nested object is authored data and merging INTO it would silently resurrect
 * defaults the author removed.
 *
 * ## Why there is no iframe here
 *
 * `editor-bridge.ts` requires a sandboxed iframe on the isolated origin for `org_custom` and
 * `marketplace` editors — a third-party editor in an authenticated staff browser is stored XSS
 * against our own users (ADR-005 threat 4). Every plugin in `FIRST_PARTY_PLUGINS` is
 * `first_party`: in this monorepo, code-reviewed, imported directly, which is exactly the tier
 * the bridge exempts. The bridge protocol lands with the first non-first-party plugin, and the
 * `patch` funnel above is the part that is already shared, on purpose ("an allowlist only used on
 * the dangerous path is an allowlist nobody notices has stopped working").
 */

'use client';

import type { AuthoredItem, EditorComponent, I18nKey, JsonPatchOp } from '@resscript/question-kit';
import { translateEditorPatch } from './editor-patch';
import { pluginFor } from './TypePicker';
import { itemLabel, type ItemWire, type NodeBody } from './wire';

/**
 * Resolve a studio-UI translation key. Phase 1 has no studio UI bundle — P1-12's translation
 * management is survey copy, not chrome — so the key's last segment is humanized. Unlike a plugin
 * NAME (see `TypePicker`), an editor field key's tail is the useful part: `editor.display` →
 * "Display", `editor.other_enabled` → "Other enabled".
 */
function humanizeKey(key: I18nKey): string {
  const tail = key.split('.').at(-1) ?? key;
  const words = tail.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toAuthoredItem(item: ItemWire, position: number): AuthoredItem {
  return {
    ref: item.ref ?? 'o' + String(item.code),
    code: item.code,
    labelKey: itemLabel(item),
    // Display position is the LIST position (schema §5.1: codes order the data, positions order
    // the pixels), so it is the index the editor is showing, not a stored counter.
    position,
    ...(item.exclusive === undefined ? {} : { exclusive: item.exclusive }),
    ...(item.anchor === undefined || item.anchor === null ? {} : { anchor: item.anchor }),
    ...(item.value_override === undefined ? {} : { valueOverride: item.value_override }),
  };
}

export interface QuestionEditorShellProps {
  readonly node: NodeBody;
  readonly lang: string;
  readonly readOnly: boolean;
  /** An accepted, translated `PATCH /nodes/{id}` body. */
  readonly onPatch: (body: Readonly<Record<string, unknown>>) => void;
  readonly onRefuse: (reason: string) => void;
}

export function QuestionEditorShell(props: QuestionEditorShellProps): React.JSX.Element {
  const { node, lang, readOnly } = props;
  const plugin = pluginFor(node.questionType);

  if (node.questionType === null) {
    return (
      <p className="rs-muted" data-testid="editor-not-a-question">
        This node has no question type — {node.kind} nodes carry structure, not answers.
      </p>
    );
  }
  if (plugin === undefined) {
    // A type the registry does not know: an org_custom or marketplace plugin that is not loaded,
    // or a stale artifact. Saying which is more useful than an empty pane.
    return (
      <p role="alert" data-testid="editor-unknown-type">
        No editor is loaded for question type “{node.questionType}”. The registry has no plugin
        with that id.
      </p>
    );
  }

  const defaults = plugin.defaultConfig({
    lang,
    ref: node.ref ?? '',
    asCellControl: false,
  }) as Record<string, unknown>;
  const config: Record<string, unknown> = { ...defaults, ...node.config };

  const options = node.items.filter((item) => (item.item_kind ?? 'option') === 'option');
  const rows = node.items.filter((item) => item.item_kind === 'row');
  const columns = node.items.filter((item) => item.item_kind === 'column');

  const question = {
    ref: node.ref ?? '',
    questionType: node.questionType,
    label: node.label,
    instruction: node.instruction,
    required: node.required,
    config,
    options: options.map(toAuthoredItem),
    rows: rows.map(toAuthoredItem),
    columns: columns.map(toAuthoredItem),
    cells: [],
    flags: { pii: false, excludeFromExport: false },
    loop: null,
  };

  const patch = (ops: readonly JsonPatchOp[]): void => {
    if (readOnly) {
      props.onRefuse('this version is frozen');
      return;
    }
    const translated = translateEditorPatch(ops, { config });
    if (!translated.ok) {
      props.onRefuse(translated.reason);
      return;
    }
    props.onPatch(translated.body);
  };

  /*
   * `AnyPluginView.editor` is `EditorComponent<never>` — the erasure the kit chose so that a
   * holder "can store and forward the component but cannot invent props for it"
   * (`contract/plugin.ts`). The host is the one place that legitimately must invent them: it is
   * where the wire body and the plugin's own `defaultConfig` meet. So the widening happens
   * exactly here, once, named — and everything it produces still goes back through `patch`.
   */
  const Editor = plugin.editor as unknown as EditorComponent<Record<string, unknown>>;

  return (
    <div data-testid="question-editor-shell" data-question-type={node.questionType}>
      <fieldset
        disabled={readOnly}
        style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}
      >
        <Editor
          question={question}
          patch={patch}
          ctx={{
            lang,
            dir: 'ltr',
            t: humanizeKey,
            requestAsset: () => {
              // F §6: the editor asks, studio picks, studio patches — and studio's picker is not
              // built yet. Refusing out loud beats an inert control.
              props.onRefuse('the asset picker arrives with the design system (P1-06)');
            },
          }}
        />
      </fieldset>
    </div>
  );
}
