"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CommandAutocompleteList,
  type CommandAutocompleteListItem,
} from "@/components/CommandAutocompleteList";
import {
  fuzzyMatch,
  compareFuzzyResults,
  type MatchTier,
} from "@/lib/shared/fuzzy";
import {
  useCommandsQuery,
  useProjectCommandsQuery,
} from "@/lib/commands/queries";
import { filterDisabledCommandItems } from "@/lib/commands/capability-filter";
import {
  useAgentCapabilityViewQuery,
  type AgentCapabilityScope,
} from "@/hooks/use-agent-capabilities";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { CommandItem } from "@/lib/commands/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
const BUILT_IN_CLAUDE_COMMANDS: readonly CommandItem[] = [
  {
    name: "/collab",
    description: "Run two agents in parallel and converge to a merged result.",
    type: "command",
    source: "built-in",
  },
  {
    name: "/commit",
    description: "Commit session changes with an agent-written message.",
    argumentHint: "[message guidance]",
    type: "command",
    source: "built-in",
  },
  {
    name: "/merge",
    description:
      "Smart-merge the session into its target with an agent-written squash message.",
    argumentHint: "[message guidance]",
    type: "command",
    source: "built-in",
  },
  {
    name: "/align",
    description:
      "Draft or update the session's shared Alignment charter from the conversation.",
    argumentHint: "[guidance]",
    type: "command",
    source: "built-in",
  },
  {
    name: "/ticket",
    description:
      "Create a ticket from this conversation's accumulated context.",
    argumentHint: "[hint text]",
    type: "command",
    source: "built-in",
  },
];

export interface SlashCommandPopupHandle {
  /** Forward a keydown event from the editor; returns true when consumed. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export interface SlashCommandSelection {
  name: string;
  trigger: "/" | "$";
  kind: "command" | "skill";
  source: string;
  description?: string;
  argumentHint?: string;
}

export interface SlashCommandPopupProps {
  /** Text typed after the trigger character (without the leading "/" or "$"). */
  query: string;
  /** Trigger character that initiated the suggestion (e.g. "/" or "$"). */
  triggerChar: string;
  projectName: string;
  sessionName: string;
  /**
   * The conversation this popup belongs to. Used to filter the catalog by CC's
   * effective capability config — items disabled at any cascade layer (global
   * through conversation) are hidden so users can't pick commands the agent
   * will reject.
   */
  conversationId: string;
  backend?: AgentBackendId;
  /**
   * Graph-workflow lane conversations (the composer mounts for them while an
   * approval gate or parked question is open) must not advertise /ticket —
   * the server rejects the command for lanes.
   */
  isWorkflowManagedConversation?: boolean;
  /** Insert the chosen command into the editor at the trigger range. */
  onSelect: (selection: SlashCommandSelection) => void;
  /** Notify the host when an item with `argumentHint` is selected. */
  onShowPlaceholder?: (text: string) => void;
  /** Dismiss the popup (Escape). Host should clear its suggestion state. */
  onClose?: () => void;
}

interface ScoredItem {
  item: CommandItem;
  tier: MatchTier;
  coverage: number;
  matchIndices: number[];
}

export const PromptEditorSlashCommandPopup = forwardRef<
  SlashCommandPopupHandle,
  SlashCommandPopupProps
>(function PromptEditorSlashCommandPopup(
  {
    query,
    triggerChar,
    projectName,
    sessionName,
    conversationId,
    backend = "claude",
    isWorkflowManagedConversation = false,
    onSelect,
    onShowPlaceholder,
    onClose,
  },
  ref,
) {
  // Project-level conversations address the otherwise session-keyed APIs via
  // the `__project__` sentinel; commands are then discovered from the project
  // root rather than a session worktree, and capabilities cascade through the
  // project-scoped conversation layer.
  const projectScoped = isProjectSentinel(sessionName);
  const sessionCommandsQuery = useCommandsQuery(
    projectName,
    sessionName,
    backend,
    { enabled: !projectScoped },
  );
  const projectCommandsQuery = useProjectCommandsQuery(projectName, backend, {
    enabled: projectScoped,
  });
  const commandsQuery = projectScoped
    ? projectCommandsQuery
    : sessionCommandsQuery;

  const capabilityScope = useMemo<AgentCapabilityScope>(() => {
    if (projectScoped) {
      // Before the first conversation exists there is no conversation layer to
      // cascade through; fall back to the project layer.
      return conversationId
        ? {
            level: "conversation",
            projectName,
            conversationScope: "project",
            conversationId,
          }
        : { level: "project", projectName };
    }
    return {
      level: "conversation",
      projectName,
      sessionName,
      conversationId,
    };
  }, [projectScoped, projectName, sessionName, conversationId]);
  const pluginsCascade =
    backend === "codex" ? "codex-plugins" : "claude-plugins";
  const skillsCascade = backend === "codex" ? "codex-skills" : "claude-skills";
  const pluginsView = useAgentCapabilityViewQuery(
    capabilityScope,
    pluginsCascade,
  );
  const skillsView = useAgentCapabilityViewQuery(
    capabilityScope,
    skillsCascade,
  );

  const isCodexSkillMode = backend === "codex" && triggerChar === "$";

  const items = useMemo<CommandItem[]>(() => {
    const availableBuiltIns = isWorkflowManagedConversation
      ? BUILT_IN_CLAUDE_COMMANDS.filter((i) => i.name !== "/ticket")
      : BUILT_IN_CLAUDE_COMMANDS;
    const fetched = commandsQuery.data?.items ?? [];
    const filtered = filterDisabledCommandItems(
      fetched,
      pluginsView.data,
      skillsView.data,
    );
    if (isCodexSkillMode) {
      return filtered.filter((i) => i.name.startsWith("$"));
    }
    if (backend === "codex") {
      return [...availableBuiltIns];
    }
    const fetchedNames = new Set(filtered.map((i) => i.name));
    const builtIns = availableBuiltIns.filter((i) => !fetchedNames.has(i.name));
    return [...builtIns, ...filtered.filter((i) => i.name.startsWith("/"))];
  }, [
    commandsQuery.data?.items,
    pluginsView.data,
    skillsView.data,
    backend,
    isCodexSkillMode,
    isWorkflowManagedConversation,
  ]);

  const scored = useMemo<ScoredItem[]>(() => {
    if (items.length === 0) return [];

    const nameMatches: ScoredItem[] = [];
    const descMatches: ScoredItem[] = [];

    for (const item of items) {
      const nameTarget = item.name.slice(1);
      const nameResult = fuzzyMatch(query, nameTarget);
      if (nameResult.match) {
        nameMatches.push({
          item,
          tier: nameResult.tier!,
          coverage: nameResult.coverage,
          matchIndices: nameResult.indices.map((i) => i + 1),
        });
        continue;
      }
      if (query.length >= 3) {
        const descResult = fuzzyMatch(query, item.description);
        if (descResult.match) {
          descMatches.push({
            item,
            tier: descResult.tier!,
            coverage: descResult.coverage,
            matchIndices: [],
          });
        }
      }
    }

    nameMatches.sort(
      (a, b) =>
        compareFuzzyResults(a, b) || a.item.name.localeCompare(b.item.name),
    );
    descMatches.sort(
      (a, b) =>
        compareFuzzyResults(a, b) || a.item.name.localeCompare(b.item.name),
    );
    return [...nameMatches, ...descMatches];
  }, [items, query]);

  const listItems = useMemo<CommandAutocompleteListItem[]>(
    () =>
      scored.map((s) => ({
        id: s.item.name,
        name: s.item.name,
        description: s.item.description,
        badge: s.item.type,
        source: s.item.source,
        matchIndices: s.matchIndices,
      })),
    [scored],
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const resetKey = `${query}:${listItems.length}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setActiveIndex(0);
  }

  const activeIndexRef = useRef(activeIndex);
  const scoredRef = useRef(scored);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);
  useEffect(() => {
    scoredRef.current = scored;
  }, [scored]);

  const selectAt = useCallback(
    (index: number) => {
      const target = scoredRef.current[index];
      if (!target) return;
      const trigger: "/" | "$" = target.item.name.startsWith("$") ? "$" : "/";
      const selection: SlashCommandSelection = {
        name: target.item.name,
        trigger,
        kind: target.item.type,
        source: target.item.source,
      };
      if (typeof target.item.description === "string") {
        selection.description = target.item.description;
      }
      if (typeof target.item.argumentHint === "string") {
        selection.argumentHint = target.item.argumentHint;
      }
      onSelect(selection);
      if (target.item.argumentHint) {
        onShowPlaceholder?.(target.item.argumentHint);
      }
    },
    [onSelect, onShowPlaceholder],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const total = scoredRef.current.length;
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, Math.max(total - 1, 0)));
          return true;
        }
        case "ArrowUp": {
          event.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          return true;
        }
        case "Enter":
        case "Tab": {
          if (total === 0) return false;
          event.preventDefault();
          selectAt(activeIndexRef.current);
          return true;
        }
        case "Escape": {
          event.preventDefault();
          event.stopPropagation();
          onClose?.();
          return true;
        }
        default:
          return false;
      }
    },
    [selectAt, onClose],
  );

  useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

  const headerLabel = isCodexSkillMode ? "Skills" : "Commands";
  const emptyLabel = isCodexSkillMode
    ? "No matching skills"
    : "No matching commands";
  const error = commandsQuery.isError
    ? (commandsQuery.error?.message ??
      `Failed to load ${headerLabel.toLowerCase()}`)
    : null;

  return (
    <CommandAutocompleteList
      items={listItems}
      selectedIndex={activeIndex}
      onHover={setActiveIndex}
      onSelect={(item) => {
        const idx = listItems.findIndex((i) => i.id === item.id);
        if (idx >= 0) selectAt(idx);
      }}
      headerLabel={headerLabel}
      emptyLabel={emptyLabel}
      loading={commandsQuery.isPending}
      error={error}
    />
  );
});
