import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";
import {
  REFERENCE_REGISTRY,
  getReferenceByType,
  type ReferencePickerContext,
  type ReferencePickerItem,
  type ReferenceType,
} from "./reference-registry";

const UNIFIED_MENTION_PLUGIN_KEY = new PluginKey("unifiedMentionSuggestion");

export interface UnifiedMentionGroup {
  type: ReferenceType;
  label: string;
  items: ReferencePickerItem[];
}

interface ParsedMentionQuery {
  type: ReferenceType | null;
  searchQuery: string;
}

export function parseUnifiedMentionQuery(query: string): ParsedMentionQuery {
  const trimmed = query.trimStart();
  const withSeparator = /^([^:\s]+)(?::|\s+)\s*(.*)$/.exec(trimmed);
  if (withSeparator) {
    const type = resolveTypeFilter(withSeparator[1] ?? "");
    if (type) {
      return { type, searchQuery: withSeparator[2] ?? "" };
    }
  }

  const exactType = resolveTypeFilter(trimmed, true);
  if (exactType) return { type: exactType, searchQuery: "" };

  return { type: null, searchQuery: trimmed };
}

export function getUnifiedMentionGroups(
  query: string,
  context: ReferencePickerContext,
): UnifiedMentionGroup[] {
  const drillIn = parseSpecDrillInQuery(query);
  if (drillIn) {
    const selectedSpec = [...context.specs]
      .sort((left, right) => {
        const leftCurrent =
          left.projectName === context.currentProjectName ? 0 : 1;
        const rightCurrent =
          right.projectName === context.currentProjectName ? 0 : 1;
        return leftCurrent - rightCurrent;
      })
      .find((spec) => spec.slug.toLowerCase() === drillIn.slug.toLowerCase());
    if (!selectedSpec) return [];
    const drillInContext = { ...context, selectedSpec };
    return REFERENCE_REGISTRY.flatMap((entry) => {
      if (
        entry.type !== "requirement" &&
        entry.type !== "decision" &&
        entry.type !== "task" &&
        entry.type !== "question" &&
        entry.type !== "assumption"
      ) {
        return [];
      }
      const items = entry.pickerSource.getItems(
        drillIn.elementQuery,
        drillInContext,
      );
      return items.length === 0
        ? []
        : [{ type: entry.type, label: entry.pickerSource.groupLabel, items }];
    });
  }

  const parsed = parseUnifiedMentionQuery(query);
  return REFERENCE_REGISTRY.flatMap((entry) => {
    if (parsed.type !== null && entry.type !== parsed.type) return [];
    const items = entry.pickerSource.getItems(parsed.searchQuery, context);
    if (items.length === 0) return [];
    return [
      {
        type: entry.type,
        label: entry.pickerSource.groupLabel,
        items,
      },
    ];
  });
}

export function parseSpecDrillInQuery(
  query: string,
): { slug: string; elementQuery: string } | null {
  const trimmed = query.trimStart();
  const separator = trimmed.indexOf("/");
  if (separator <= 0) return null;
  return {
    slug: trimmed.slice(0, separator),
    elementQuery: trimmed.slice(separator + 1),
  };
}

function resolveTypeFilter(
  token: string,
  requireExact = false,
): ReferenceType | null {
  const normalized = token.toLowerCase();
  if (normalized.length === 0) return null;
  const matches = REFERENCE_REGISTRY.filter((entry) =>
    entry.pickerSource.queryAliases.some((alias) =>
      requireExact ? alias === normalized : alias.startsWith(normalized),
    ),
  );
  return matches.length === 1 ? matches[0]!.type : null;
}

export interface UnifiedMentionExtensionOptions {
  items: (props: { query: string }) => UnifiedMentionGroup[];
  render: () => {
    onStart?: (
      props: SuggestionProps<UnifiedMentionGroup, ReferencePickerItem>,
    ) => void;
    onUpdate?: (
      props: SuggestionProps<UnifiedMentionGroup, ReferencePickerItem>,
    ) => void;
    onExit?: (
      props: SuggestionProps<UnifiedMentionGroup, ReferencePickerItem>,
    ) => void;
    onKeyDown?: (props: SuggestionKeyDownProps) => boolean;
  };
}

export const UnifiedMention = Extension.create<UnifiedMentionExtensionOptions>({
  name: "unifiedMentionSuggestion",

  addOptions() {
    return {
      items: () => [],
      render: () => ({}),
    };
  },

  addProseMirrorPlugins() {
    const { items, render } = this.options;
    const suggestionOptions: SuggestionOptions<
      UnifiedMentionGroup,
      ReferencePickerItem
    > = {
      editor: this.editor,
      pluginKey: UNIFIED_MENTION_PLUGIN_KEY,
      char: "#",
      allowSpaces: false,
      items: ({ query }) => items({ query }),
      render,
      command: ({ editor, range, props }) => {
        const entry = getReferenceByType(props.type);
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: entry.nodeName, attrs: props.attrs },
            { type: "text", text: " " },
          ])
          .run();
      },
    };
    return [Suggestion(suggestionOptions)];
  },
});
