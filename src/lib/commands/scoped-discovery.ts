import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import type {
  CapabilityRouteDeps,
  CapabilityRouteScope,
} from "@/lib/agent-capabilities/route-handlers";
import { defaultCapabilityRouteDeps } from "@/lib/agent-capabilities/route-defaults";
import {
  ownedCascadesForBackend,
  projectResolvedCascade,
} from "@/lib/agent-capabilities/runtime-composer";
import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityViewResponse,
} from "@/lib/agent-capabilities/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { CommandItem } from "./schemas";
import { discoverCommands } from "./service";

export interface ScopedCommandDiscoveryDeps extends Pick<
  CapabilityRouteDeps,
  "resolveView"
> {
  discoverCommands(
    worktreePath: string,
    backend: AgentBackendId,
    options?: {
      conversationId?: string;
      resolveCapabilities?(): Promise<ResolvedCapabilityCascade>;
    },
  ): Promise<CommandItem[]>;
}

export function createScopedCommandDiscovery(deps: ScopedCommandDiscoveryDeps) {
  return async (
    worktreePath: string,
    backend: AgentBackendId,
    scope: CapabilityRouteScope,
  ): Promise<CommandItem[]> =>
    deps.discoverCommands(worktreePath, backend, {
      ...(scope.level === "conversation"
        ? { conversationId: scope.conversationId }
        : {}),
      async resolveCapabilities() {
        const views: Partial<
          Record<AgentCapabilityCascadeKind, AgentCapabilityViewResponse>
        > = {};
        for (const { cascadeKind } of ownedCascadesForBackend(backend)) {
          views[cascadeKind] = await deps.resolveView({ scope, cascadeKind });
        }
        return projectResolvedCascade(backend, views);
      },
    });
}

export const discoverScopedCommands = createScopedCommandDiscovery({
  resolveView: defaultCapabilityRouteDeps.resolveView,
  discoverCommands,
});
