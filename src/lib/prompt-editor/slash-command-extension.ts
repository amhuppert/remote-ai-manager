import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";

/**
 * Item shape provided by the host application's command catalog. The
 * extension is intentionally generic; the host decides what command items
 * mean and how to render them in the popup.
 *
 * On select, the extension inserts a `slashCommandMarker` chip node carrying
 * these attributes so the editor can render a styled badge while
 * `serializePromptDoc` round-trips the original name verbatim on the wire.
 */
export interface SlashCommandItem {
  /** Stable id used as React key */
  id: string;
  /** Full command name including the trigger character (e.g. `/spec-init`). */
  name: string;
  /** Trigger character that produced this item — `/` for commands, `$` for skills. */
  trigger: "/" | "$";
  /** Display category for badge/source styling. */
  kind: "command" | "skill";
  /** Human-readable origin (e.g. `built-in`, `user`, `project`). */
  source: string;
  /** Optional description, surfaced as the chip's tooltip. */
  description?: string;
  /** Optional argument hint shown as ghost text after the chip. */
  argumentHint?: string;
}

interface SlashCommandTriggerHandlers {
  onStart?: (props: SuggestionProps<SlashCommandItem>) => void;
  onUpdate?: (props: SuggestionProps<SlashCommandItem>) => void;
  onExit?: (props: SuggestionProps<SlashCommandItem>) => void;
  onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
}

export interface SlashCommandTrigger {
  /** Trigger character, e.g. `/` for Claude commands or `$` for Codex skills. */
  char: string;
  /** Returns the filtered command list for the current query. */
  items: (props: { query: string }) => SlashCommandItem[];
  /** Mount the suggestion popup. Receives the same props Tiptap forwards. */
  render: () => SlashCommandTriggerHandlers;
}

export interface SlashCommandExtensionOptions {
  /**
   * One trigger per character; each registers an independent
   * `@tiptap/suggestion` plugin with its own popup callbacks.
   */
  triggers: SlashCommandTrigger[];
}

/**
 * Tiptap extension wiring `@tiptap/suggestion` plugins for one or more
 * trigger characters (e.g. `/` for Claude commands, `$` for Codex skills).
 * Each trigger gets its own plugin key so multiple suggestions can coexist
 * in the same editor. Inserts the selected `insertText` plus a trailing
 * space at the trigger range.
 */
export const SlashCommand = Extension.create<SlashCommandExtensionOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      triggers: [],
    };
  },

  addProseMirrorPlugins() {
    return this.options.triggers.map((trigger) => {
      const pluginKey = new PluginKey(`slashCommandSuggestion-${trigger.char}`);
      const suggestionOptions: SuggestionOptions<
        SlashCommandItem,
        SlashCommandItem
      > = {
        editor: this.editor,
        pluginKey,
        char: trigger.char,
        startOfLine: true,
        allowSpaces: false,
        items: ({ query }) => trigger.items({ query }),
        render: trigger.render,
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "slashCommandMarker",
                attrs: {
                  name: props.name,
                  trigger: props.trigger,
                  kind: props.kind,
                  source: props.source,
                  description: props.description ?? null,
                  argumentHint: props.argumentHint ?? null,
                },
              },
              { type: "text", text: " " },
            ])
            .run();
        },
      };
      return Suggestion(suggestionOptions);
    });
  },
});
