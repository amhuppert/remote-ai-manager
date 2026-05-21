import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import SlashCommandChip from "@/app/projects/[name]/[session]/SlashCommandChip";

export type SlashCommandKind = "command" | "skill";
export type SlashCommandTriggerChar = "/" | "$";

export interface SlashCommandMarkerAttrs {
  name: string;
  trigger: SlashCommandTriggerChar;
  kind: SlashCommandKind;
  source: string;
  description: string | null;
  argumentHint: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    slashCommandMarker: {
      insertSlashCommandMarker: (attrs: SlashCommandMarkerAttrs) => ReturnType;
    };
  }
}

/**
 * Atomic inline node representing a selected slash command (Claude `/`) or
 * Codex skill (`$`) in the prompt editor. Wire-format round-trip is handled
 * by `serializePromptDoc`, which emits `attrs.name` verbatim — keeping the
 * agent payload identical to the pre-chip plain-text behavior.
 */
export const SlashCommandMarker = Node.create({
  name: "slashCommandMarker",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-name") ?? "",
        renderHTML: (attributes) => ({
          "data-name": String(attributes["name"] ?? ""),
        }),
      },
      trigger: {
        default: "/" as SlashCommandTriggerChar,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-trigger");
          return raw === "$" ? "$" : "/";
        },
        renderHTML: (attributes) => ({
          "data-trigger": String(attributes["trigger"] ?? "/"),
        }),
      },
      kind: {
        default: "command" as SlashCommandKind,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-kind");
          return raw === "skill" ? "skill" : "command";
        },
        renderHTML: (attributes) => ({
          "data-kind": String(attributes["kind"] ?? "command"),
        }),
      },
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? "",
        renderHTML: (attributes) => ({
          "data-source": String(attributes["source"] ?? ""),
        }),
      },
      description: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute("data-description"),
        renderHTML: (attributes) => {
          const desc = attributes["description"];
          if (typeof desc !== "string" || desc.length === 0) return {};
          return { "data-description": desc };
        },
      },
      argumentHint: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute("data-argument-hint"),
        renderHTML: (attributes) => {
          const hint = attributes["argumentHint"];
          if (typeof hint !== "string" || hint.length === 0) return {};
          return { "data-argument-hint": hint };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-slash-command-marker]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-slash-command-marker": "",
        class: "slash-command-chip",
      }),
      String(HTMLAttributes["data-name"] ?? ""),
    ];
  },

  renderText({ node }) {
    const name = node.attrs["name"];
    return typeof name === "string" ? name : "";
  },

  addCommands() {
    return {
      insertSlashCommandMarker:
        (attrs: SlashCommandMarkerAttrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs,
          }),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(SlashCommandChip);
  },
});
