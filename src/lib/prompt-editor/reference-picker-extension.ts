import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  parseScopeQuery,
  type PickerSelection,
  type PickerTrigger,
} from "./reference-picker";
import { getReferenceByType } from "./reference-registry";

const PLUGIN_KEYS: Record<PickerTrigger, PluginKey> = {
  "@": new PluginKey("referencePickerAt"),
  "#": new PluginKey("referencePickerHash"),
  "!": new PluginKey("referencePickerBang"),
};

export const REFERENCE_PICKER_TRIGGERS: readonly PickerTrigger[] = [
  "@",
  "#",
  "!",
];

/**
 * A query that swallowed a later trigger. Spaces keep a match growing, so
 * `#note @file` matches both the `#` and the `@` plugin at once; the earlier
 * trigger yields so exactly one picker owns the caret.
 */
const LATER_TRIGGER = /\s[@#!]/;

export interface ReferencePickerSuggestion {
  trigger: PickerTrigger;
  query: string;
  /** Insert the chosen row over the trigger range. */
  select(selection: PickerSelection): void;
  /**
   * Rewrite the query in place and leave the picker open. Backs the `→` key,
   * which completes the highlighted row's text without committing to it.
   */
  complete(text: string): void;
  /** True when the caret sits at the end of the query, read at call time. */
  isCaretAtQueryEnd(): boolean;
}

export interface ReferencePickerExtensionOptions {
  /** Mount, update, and tear down the popup for one trigger. */
  render: (trigger: PickerTrigger) => {
    onStart?: (suggestion: ReferencePickerSuggestion) => void;
    onUpdate?: (suggestion: ReferencePickerSuggestion) => void;
    onExit?: () => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
  /**
   * Whether any scope still matches `query`. Once a query has grown a space it
   * is usually prose rather than a reference, so the picker steps aside when it
   * has nothing left to offer; backspacing to a matching query reopens it.
   */
  hasAnyMatch: (query: string) => boolean;
}

/**
 * The `@`, `#`, and `!` triggers of the unified reference picker. Each is its
 * own suggestion plugin — they have to match independently — but they share one
 * popup, one item model, and one insertion path, so the trigger character only
 * preselects a scope and any trigger can insert any kind.
 */
export const ReferencePicker =
  Extension.create<ReferencePickerExtensionOptions>({
    name: "referencePickerSuggestion",

    // Above TerminalHotkeys (1000), which binds Alt+D to delete-word-forward
    // and claims the key even when it deletes nothing. An open picker owns
    // Alt+D and Alt+A; it declines every key it does not handle, so the
    // readline hotkeys are unaffected whenever the picker is closed.
    priority: 1100,

    addOptions() {
      return {
        render: () => ({}),
        hasAnyMatch: () => true,
      };
    },

    addProseMirrorPlugins() {
      const { render, hasAnyMatch } = this.options;
      return REFERENCE_PICKER_TRIGGERS.map((trigger) => {
        const renderer = render(trigger);
        const options: SuggestionOptions<never, PickerSelection> = {
          editor: this.editor,
          pluginKey: PLUGIN_KEYS[trigger],
          char: trigger,
          // References worth naming contain spaces, so a space keeps the query
          // growing instead of ending it; `shouldShow` bounds the consequence.
          allowSpaces: true,
          items: () => [],
          shouldShow: ({ query }) =>
            !LATER_TRIGGER.test(query) &&
            (!/\s/.test(query) ||
              parseScopeQuery(query).scope !== null ||
              hasAnyMatch(query)),
          render: () => ({
            onStart: (props) =>
              renderer.onStart?.(toSuggestion(trigger, props)),
            onUpdate: (props) =>
              renderer.onUpdate?.(toSuggestion(trigger, props)),
            onExit: () => renderer.onExit?.(),
            onKeyDown: (props) => renderer.onKeyDown?.(props) ?? false,
          }),
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                mentionNode(props),
                { type: "text", text: " " },
              ])
              .run();
          },
        };
        return Suggestion(options);
      });
    },
  });

function mentionNode(selection: PickerSelection): {
  type: string;
  attrs: Record<string, unknown>;
} {
  if (selection.kind === "file") {
    return {
      type: "fileMention",
      attrs: {
        path: selection.path,
        basename: selection.basename,
        ext: selection.ext,
      },
    };
  }
  return {
    type: getReferenceByType(selection.type).nodeName,
    attrs: selection.attrs,
  };
}

function toSuggestion(
  trigger: PickerTrigger,
  props: SuggestionProps<never, PickerSelection>,
): ReferencePickerSuggestion {
  return {
    trigger,
    query: props.query,
    select: (selection) => props.command(selection),
    isCaretAtQueryEnd: () =>
      props.editor.state.selection.head === props.range.to,
    complete: (text) => {
      // A text node rather than a string: completions carry user-authored
      // titles, which must never be parsed as markup.
      props.editor
        .chain()
        .focus()
        .insertContentAt(props.range, [
          { type: "text", text: `${trigger}${text}` },
        ])
        .run();
    },
  };
}
