import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";

const FILE_MENTION_PLUGIN_KEY = new PluginKey("fileMentionSuggestion");

/**
 * A single file candidate offered by the host's file index for `@`-mention
 * autocomplete. The extension is generic — the host decides matching,
 * scoring, and popup rendering.
 */
export interface FileMentionItem {
  /** Stable id used as React key */
  id: string;
  /** The path inserted into the document on select (e.g. `src/lib/foo.ts`) */
  path: string;
  /** Optional payload preserved for the popup renderer */
  data?: Record<string, unknown>;
}

export interface FileMentionExtensionOptions {
  /** Trigger character. Defaults to `@`. */
  char?: string;
  /** Returns the filtered file list for the current query. */
  items: (props: { query: string }) => FileMentionItem[];
  /** Mount the suggestion popup. Receives the same props Tiptap forwards. */
  render: () => {
    onStart?: (props: SuggestionProps<FileMentionItem>) => void;
    onUpdate?: (props: SuggestionProps<FileMentionItem>) => void;
    onExit?: (props: SuggestionProps<FileMentionItem>) => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
}

/**
 * Tiptap extension wiring the `@tiptap/suggestion` plugin for `@`-prefixed
 * file mentions. Inserts the selected path verbatim at the trigger range,
 * preserving the leading `@`. Item filtering and popup rendering are
 * provided by the caller via `options.items` and `options.render`.
 */
export const FileMention = Extension.create<FileMentionExtensionOptions>({
  name: "fileMention",

  addOptions() {
    return {
      char: "@",
      items: () => [],
      render: () => ({}),
    };
  },

  addProseMirrorPlugins() {
    const { char, items, render } = this.options;

    const suggestionOptions: SuggestionOptions<
      FileMentionItem,
      FileMentionItem
    > = {
      editor: this.editor,
      pluginKey: FILE_MENTION_PLUGIN_KEY,
      char: char ?? "@",
      allowSpaces: false,
      items: ({ query }) => items({ query }),
      render,
      command: ({ editor, range, props }) => {
        editor.chain().focus().insertContentAt(range, `@${props.path} `).run();
      },
    };

    return [Suggestion(suggestionOptions)];
  },
});
