import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import type { ConversationMentionAttrs } from "./conversation-mention-node";

const CONVERSATION_MENTION_PLUGIN_KEY = new PluginKey(
  "conversationMentionSuggestion",
);

/**
 * A single conversation candidate offered by the cross-project autocomplete
 * query. The extension is generic — the host (popup) decides filtering,
 * scoring, and rendering. On select, the extension inserts a
 * `conversationMention` chip node carrying these attributes and emits a
 * canonical `<conversation-ref ... />` XML tag at serialization time.
 */
export interface ConversationMentionItem extends ConversationMentionAttrs {
  /** Stable id used as React key. */
  id: string;
}

export interface ConversationMentionExtensionOptions {
  /** Trigger character. Defaults to `#`. */
  char?: string;
  /** Returns the filtered conversation list for the current query. */
  items: (props: { query: string }) => ConversationMentionItem[];
  /** Mount the suggestion popup. Receives the same props Tiptap forwards. */
  render: () => {
    onStart?: (props: SuggestionProps<ConversationMentionItem>) => void;
    onUpdate?: (props: SuggestionProps<ConversationMentionItem>) => void;
    onExit?: (props: SuggestionProps<ConversationMentionItem>) => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
}

export const ConversationMention =
  Extension.create<ConversationMentionExtensionOptions>({
    name: "conversationMentionSuggestion",

    addOptions() {
      return {
        char: "#",
        items: () => [],
        render: () => ({}),
      };
    },

    addProseMirrorPlugins() {
      const { char, items, render } = this.options;

      const suggestionOptions: SuggestionOptions<
        ConversationMentionItem,
        ConversationMentionItem
      > = {
        editor: this.editor,
        pluginKey: CONVERSATION_MENTION_PLUGIN_KEY,
        char: char ?? "#",
        allowSpaces: false,
        items: ({ query }) => items({ query }),
        render,
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "conversationMention",
                attrs: {
                  projectName: props.projectName,
                  projectPath: props.projectPath,
                  sessionName: props.sessionName,
                  worktreePath: props.worktreePath,
                  conversationId: props.conversationId,
                  conversationName: props.conversationName,
                  backend: props.backend,
                  backendRef: props.backendRef,
                  transcriptPath: props.transcriptPath,
                  debugLogPath: props.debugLogPath,
                  status: props.status,
                  lastActivityAt: props.lastActivityAt,
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
