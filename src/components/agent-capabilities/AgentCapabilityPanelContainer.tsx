"use client";

import { useMemo, useState } from "react";

import {
  useResetAgentCapabilityItemMutation,
  useAgentCapabilityViewQuery,
  useRefreshAgentCapabilityMutation,
  useToggleAgentCapabilityItemMutation,
  type AgentCapabilityScope,
} from "@/hooks/use-agent-capabilities";
import type { AgentCapabilityCascadeKind } from "@/lib/schemas";

import {
  AgentCapabilityPanel,
  titleForCapabilityCascade,
  type AgentCapabilityLayerOption,
} from "./AgentCapabilityPanel";

export interface AgentCapabilityPanelContainerProps {
  cascadeKind: AgentCapabilityCascadeKind;
  layerOptions: readonly AgentCapabilityLayerOption[];
  initialScope?: AgentCapabilityScope;
}

export function AgentCapabilityPanelContainer({
  cascadeKind,
  layerOptions,
  initialScope,
}: AgentCapabilityPanelContainerProps): React.JSX.Element {
  const [selectedScope, setSelectedScope] = useState<AgentCapabilityScope>(
    () => initialScope ?? layerOptions[0]?.scope ?? { level: "global" },
  );
  const query = useAgentCapabilityViewQuery(selectedScope, cascadeKind, {
    enabled: layerOptions.length > 0,
  });
  const refresh = useRefreshAgentCapabilityMutation(selectedScope, cascadeKind);
  const toggleItem = useToggleAgentCapabilityItemMutation(
    selectedScope,
    cascadeKind,
  );
  const resetItem = useResetAgentCapabilityItemMutation(
    selectedScope,
    cascadeKind,
  );

  const errorMessage = useMemo(() => {
    if (query.isError) {
      return query.error?.message ?? "Capability view could not be loaded.";
    }
    if (refresh.isError) {
      return refresh.error?.message ?? "Capability refresh failed.";
    }
    return undefined;
  }, [query.error, query.isError, refresh.error, refresh.isError]);

  return (
    <AgentCapabilityPanel
      title={titleForCapabilityCascade(cascadeKind)}
      view={query.data}
      layerOptions={layerOptions}
      selectedScope={selectedScope}
      onScopeChange={setSelectedScope}
      loading={query.isPending || refresh.isPending}
      errorMessage={errorMessage}
      onRefresh={() => refresh.mutate()}
      onToggleItem={(itemId, enabled) => {
        toggleItem.mutate({ itemId, enabled });
      }}
      onResetItem={(itemId) => {
        resetItem.mutate({ itemId });
      }}
      pendingItemIds={[
        ...(toggleItem.isPending ? [toggleItem.variables.itemId] : []),
        ...(resetItem.isPending ? [resetItem.variables.itemId] : []),
      ]}
    />
  );
}

export function ClaudeSkillsCapabilityPanel(
  props: Omit<AgentCapabilityPanelContainerProps, "cascadeKind">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanelContainer {...props} cascadeKind="claude-skills" />
  );
}

export function ClaudePluginsCapabilityPanel(
  props: Omit<AgentCapabilityPanelContainerProps, "cascadeKind">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanelContainer {...props} cascadeKind="claude-plugins" />
  );
}

export function ClaudeSubAgentsCapabilityPanel(
  props: Omit<AgentCapabilityPanelContainerProps, "cascadeKind">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanelContainer {...props} cascadeKind="claude-agents" />
  );
}

export function CodexSkillsCapabilityPanel(
  props: Omit<AgentCapabilityPanelContainerProps, "cascadeKind">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanelContainer {...props} cascadeKind="codex-skills" />
  );
}

export function CodexPluginsCapabilityPanel(
  props: Omit<AgentCapabilityPanelContainerProps, "cascadeKind">,
): React.JSX.Element {
  return (
    <AgentCapabilityPanelContainer {...props} cascadeKind="codex-plugins" />
  );
}
