import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import type { TicketMentionAttrs } from "./ticket-mention-node";

const TICKET_SHORTCUT_PLUGIN_KEY = new PluginKey("ticketShortcutSuggestion");

export interface TicketShortcutItem extends TicketMentionAttrs {
  id: string;
}

export interface TicketShortcutExtensionOptions {
  items: (props: { query: string }) => TicketShortcutItem[];
  render: () => {
    onStart?: (props: SuggestionProps<TicketShortcutItem>) => void;
    onUpdate?: (props: SuggestionProps<TicketShortcutItem>) => void;
    onExit?: (props: SuggestionProps<TicketShortcutItem>) => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
}

export const TicketShortcut = Extension.create<TicketShortcutExtensionOptions>({
  name: "ticketShortcutSuggestion",

  addOptions() {
    return { items: () => [], render: () => ({}) };
  },

  addProseMirrorPlugins() {
    const { items, render } = this.options;
    const suggestionOptions: SuggestionOptions<
      TicketShortcutItem,
      TicketShortcutItem
    > = {
      editor: this.editor,
      pluginKey: TICKET_SHORTCUT_PLUGIN_KEY,
      char: "!",
      allowSpaces: false,
      items: ({ query }) => items({ query }),
      render,
      command: ({ editor, range, props }) => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "ticketMention",
              attrs: {
                projectName: props.projectName,
                ticketNumber: props.ticketNumber,
                identifier: props.identifier,
                title: props.title,
              },
            },
            { type: "text", text: " " },
          ])
          .run();
      },
    };
    return [Suggestion(suggestionOptions)];
  },
});
