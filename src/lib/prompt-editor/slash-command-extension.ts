import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";

const SLASH_COMMAND_PLUGIN_KEY = new PluginKey("slashCommandSuggestion");

/**
 * Item shape provided by the host application's command catalog. The
 * extension is intentionally generic; the host decides what command items
 * mean and how to render them in the popup.
 */
export interface SlashCommandItem {
  /** Stable id used as React key */
  id: string;
  /** The text inserted into the document on select (e.g. `/spec-init`) */
  insertText: string;
  /** Optional payload preserved for the popup renderer */
  data?: Record<string, unknown>;
}

export interface SlashCommandExtensionOptions {
  /** Trigger character. Defaults to `/`; pass `$` for Codex-mode skills. */
  char?: string;
  /** Returns the filtered command list for the current query. */
  items: (props: { query: string }) => SlashCommandItem[];
  /** Mount the suggestion popup. Receives the same props Tiptap forwards. */
  render: () => {
    onStart?: (props: SuggestionProps<SlashCommandItem>) => void;
    onUpdate?: (props: SuggestionProps<SlashCommandItem>) => void;
    onExit?: (props: SuggestionProps<SlashCommandItem>) => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
}

/**
 * Tiptap extension wiring the `@tiptap/suggestion` plugin for slash-command
 * (or `$`-skill) triggers. Inserts the selected `insertText` plus a trailing
 * space at the trigger range. Item filtering and popup rendering are
 * provided by the caller via `options.items` and `options.render`.
 */
export const SlashCommand = Extension.create<SlashCommandExtensionOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      char: "/",
      items: () => [],
      render: () => ({}),
    };
  },

  addProseMirrorPlugins() {
    const { char, items, render } = this.options;

    const suggestionOptions: SuggestionOptions<
      SlashCommandItem,
      SlashCommandItem
    > = {
      editor: this.editor,
      pluginKey: SLASH_COMMAND_PLUGIN_KEY,
      char: char ?? "/",
      startOfLine: true,
      allowSpaces: false,
      items: ({ query }) => items({ query }),
      render,
      command: ({ editor, range, props }) => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, `${props.insertText} `)
          .run();
      },
    };

    return [Suggestion(suggestionOptions)];
  },
});
