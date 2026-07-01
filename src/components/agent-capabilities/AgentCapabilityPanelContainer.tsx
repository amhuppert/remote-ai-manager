"use client";

import { useMemo, useState } from "react";

import {
  useResetAgentCapabilityItemMutation,
  useAgentCapabilityViewQuery,
  useRefreshAgentCapabilityMutation,
  useToggleAgentCapabilityItemMutation,
  type AgentCapabilityScope,
} from "@/hooks/use-agent-capabilities";
import type { AgentCapabilityCascadeKind } from "@/lib/agent-capabilities/schemas";

import {
  AgentCapabilityPanel,
  titleForCapabilityCascade,
  type AgentCapabilityLayerOption,
} from "./AgentCapabilityPanel";

export interface AgentCapabilityPanelContainerProps {
  cascadeKind: AgentCapabilityCascadeKind;
  layerOptions: readonly AgentCapabilityLayerOption[];
  initialScope?: AgentCapabilityScope;
  selectedScope?: AgentCapabilityScope;
  onScopeChange?: (scope: AgentCapabilityScope) => void;
  onOpenPlugin?: (pluginId: string, backend: "claude" | "codex") => void;
  initialSearch?: string;
  hideHeader?: boolean;
  hideLevels?: boolean;
}

export function AgentCapabilityPanelContainer({
  cascadeKind,
  layerOptions,
  initialScope,
  selectedScope,
  onScopeChange,
  onOpenPlugin,
  initialSearch,
  hideHeader,
  hideLevels,
}: AgentCapabilityPanelContainerProps): React.JSX.Element {
  const [localSelectedScope, setLocalSelectedScope] =
    useState<AgentCapabilityScope>(
      () => initialScope ?? layerOptions[0]?.scope ?? { level: "global" },
    );
  const effectiveScope = selectedScope ?? localSelectedScope;
  const setEffectiveScope = onScopeChange ?? setLocalSelectedScope;

  const query = useAgentCapabilityViewQuery(effectiveScope, cascadeKind, {
    enabled: layerOptions.length > 0,
  });
  const refresh = useRefreshAgentCapabilityMutation(
    effectiveScope,
    cascadeKind,
  );
  const toggleItem = useToggleAgentCapabilityItemMutation(
    effectiveScope,
    cascadeKind,
  );
  const resetItem = useResetAgentCapabilityItemMutation(
    effectiveScope,
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
      selectedScope={effectiveScope}
      onScopeChange={setEffectiveScope}
      loading={query.isPending || refresh.isPending}
      refreshing={refresh.isPending}
      errorMessage={errorMessage}
      onRefresh={() => refresh.mutate()}
      onToggleItem={(itemId, enabled) => {
        toggleItem.mutate({ itemId, enabled });
      }}
      onResetItem={(itemId) => {
        resetItem.mutate({ itemId });
      }}
      onOpenPlugin={onOpenPlugin}
      initialSearch={initialSearch}
      pendingItemIds={[
        ...(toggleItem.isPending ? [toggleItem.variables.itemId] : []),
        ...(resetItem.isPending ? [resetItem.variables.itemId] : []),
      ]}
      hideHeader={hideHeader}
      hideLevels={hideLevels}
    />
  );
}
