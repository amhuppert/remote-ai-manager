import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { publishEvent } from "@/lib/events/publication";
import type {
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityRuntimeApplicationState,
} from "./schemas";
import { encodeCascadeKind } from "./schemas";
import { reconcileDeliveredCapabilityState } from "./runtime-seed";

export async function recordCapabilityConfigReceipt(
  target: ConversationTarget,
  delivered: ResolvedCapabilityCascade,
  update: (
    updater: (
      current: AgentCapabilityRuntimeApplicationState | undefined,
    ) => AgentCapabilityRuntimeApplicationState,
  ) => Promise<void>,
  emit: (event: AgentCapabilitiesUpdatedEvent) => void = publishEvent,
): Promise<void> {
  let events: AgentCapabilitiesUpdatedEvent[] = [];
  await update((current) => {
    const next = reconcileDeliveredCapabilityState(
      current ?? { cascades: {} },
      delivered,
    );
    events = delivered.kinds.flatMap((kind) => {
      const cascadeKind = encodeCascadeKind({
        backend: delivered.backend,
        kind: kind.kind,
      });
      const accepted = next.cascades[cascadeKind];
      const effectiveHash = accepted?.pendingHash ?? accepted?.appliedHash;
      if (!effectiveHash) return [];
      const changedItemIds = [
        ...(current?.cascades[cascadeKind]?.pendingItemIds ?? []),
      ];
      const scope = {
        level: "conversation" as const,
        projectName: target.projectName,
        conversationScope: target.scope,
        conversationId: target.conversationId,
        ...(target.scope === "session"
          ? { sessionName: target.sessionName }
          : {}),
      };
      return [
        {
          type: "agent-capabilities-updated" as const,
          ...scope,
          cascadeKind,
          backend: delivered.backend,
          changedItemIds,
          effectiveHash,
          invalidationHints: {
            ...scope,
            cascadeKind,
            itemIds: changedItemIds,
            effectiveHash,
          },
        },
      ];
    });
    return next;
  });
  for (const event of events) emit(event);
}
