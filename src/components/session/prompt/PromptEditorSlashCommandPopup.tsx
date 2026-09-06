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
import { filterCommandsForScope } from "@/lib/commands/built-in-commands";
import { applyCommandAvailability } from "@/lib/commands/command-availability";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import {
  composeBackendCommandCatalog,
  isSkillTriggerActive,
} from "@/lib/commands/backend-command-catalog";
import { skillTriggerPrefixForBackend } from "@/lib/agent-backends/catalog";
import { commandCascadesForBackend } from "@/lib/agent-capabilities/metadata";
import {
  useAgentCapabilityViewQuery,
  type AgentCapabilityScope,
} from "@/hooks/use-agent-capabilities";
import { conversationCapabilityScope } from "@/components/agent-capabilities/conversation-capability-scope";
import type { CommandItem } from "@/lib/commands/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  scopeRefSessionName,
  type ConversationScopeRef,
} from "@/lib/conversations/conversation-target";

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
  /**
   * Explicit scope (D1). A discriminated union rather than an optional
   * `sessionName`: "undefined means project" read a sentinel-valued session
   * name as a real session, leaking it into the commands URL and the capability
   * query key (R1.3).
   */
  scopeRef: ConversationScopeRef;
  /**
   * The conversation this popup belongs to. Used to filter the catalog by CC's
   * effective capability config — items disabled at any cascade layer (global
   * through conversation) are hidden so users can't pick commands the agent
   * will reject.
   */
  conversationId?: string;
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
    scopeRef,
    conversationId,
    backend = "claude",
    isWorkflowManagedConversation = false,
    onSelect,
    onShowPlaceholder,
    onClose,
  },
  ref,
) {
  // Project-level prompts discover commands from the project root rather than
  // a session worktree, and capabilities cascade through the project-scoped
  // conversation layer when a conversation exists.
  const projectScoped = scopeRef.scope === "project";
  const backendCatalog = useBackendCatalogQuery();
  const sessionName = scopeRefSessionName(scopeRef);
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

  const capabilityScope = useMemo<AgentCapabilityScope>(
    () =>
      conversationCapabilityScope({
        scope: scopeRef,
        projectName,
        conversationId,
      }),
    [scopeRef, projectName, conversationId],
  );
  // Which cascades filter this backend's discovered commands, and which prefix
  // its skills answer to, are both registered facts. A backend that registers
  // no capability kinds gets null and issues no cascade request (spec D14).
  const cascades = useMemo(() => commandCascadesForBackend(backend), [backend]);
  const skillTriggerPrefix = skillTriggerPrefixForBackend(backend);
  const pluginsView = useAgentCapabilityViewQuery(
    capabilityScope,
    cascades.plugins,
  );
  const skillsView = useAgentCapabilityViewQuery(
    capabilityScope,
    cascades.skills,
  );

  const skillTriggerActive = isSkillTriggerActive(
    skillTriggerPrefix,
    triggerChar,
  );

  const items = useMemo<CommandItem[]>(() => {
    const fetched = commandsQuery.data?.items ?? [];
    const filtered = filterDisabledCommandItems(
      fetched,
      pluginsView.data,
      skillsView.data,
    );
    // One exit point, so a command the scope cannot execute cannot re-enter the
    // catalog by being discovered instead of built in.
    return filterCommandsForScope(
      applyCommandAvailability(
        composeBackendCommandCatalog({
          discovered: filtered,
          skillTriggerPrefix,
          triggerChar,
        }),
        backendCatalog.isFetched && !backendCatalog.isError
          ? backendCatalog.data
          : [],
        backend,
      ),
      { scope: scopeRef, isWorkflowManagedConversation },
    );
  }, [
    commandsQuery.data?.items,
    pluginsView.data,
    skillsView.data,
    skillTriggerPrefix,
    triggerChar,
    isWorkflowManagedConversation,
    scopeRef,
    backendCatalog.data,
    backendCatalog.isFetched,
    backendCatalog.isError,
    backend,
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
        disabled: s.item.availability?.status === "unavailable",
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
      if (!target || target.item.availability?.status === "unavailable") return;
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

  const headerLabel = skillTriggerActive ? "Skills" : "Commands";
  const emptyLabel = skillTriggerActive
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
