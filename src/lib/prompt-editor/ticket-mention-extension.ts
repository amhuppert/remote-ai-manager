import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import type { TicketMentionAttrs } from "./ticket-mention-node";

const TICKET_MENTION_PLUGIN_KEY = new PluginKey("ticketMentionSuggestion");

export interface TicketMentionItem extends TicketMentionAttrs {
  id: string;
}

export interface TicketMentionExtensionOptions {
  char?: string;
  items: (props: { query: string }) => TicketMentionItem[];
  render: () => {
    onStart?: (props: SuggestionProps<TicketMentionItem>) => void;
    onUpdate?: (props: SuggestionProps<TicketMentionItem>) => void;
    onExit?: (props: SuggestionProps<TicketMentionItem>) => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
}

export const TicketMention = Extension.create<TicketMentionExtensionOptions>({
  name: "ticketMentionSuggestion",

  addOptions() {
    return { char: "!", items: () => [], render: () => ({}) };
  },

  addProseMirrorPlugins() {
    const { char, items, render } = this.options;
    const suggestionOptions: SuggestionOptions<
      TicketMentionItem,
      TicketMentionItem
    > = {
      editor: this.editor,
      pluginKey: TICKET_MENTION_PLUGIN_KEY,
      char: char ?? "!",
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
