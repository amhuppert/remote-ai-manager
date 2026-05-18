/**
 * Pure patching for `AgentCapabilityOverrides`.
 *
 * Applies `set-item-enabled` and `reset-item` operations to a single layer's
 * override snapshot, returning a new snapshot and the unique list of item ids
 * whose stored override actually changed.
 *
 * Properties guaranteed by this module:
 *  - Input is never mutated.
 *  - Operations on one cascade kind leave every other cascade record untouched.
 *  - Sibling items within the same cascade are preserved.
 *  - Empty `items` records and empty cascade records are pruned so persisted
 *    state stays small after resets.
 *  - Unknown item ids are accepted on `set-item-enabled` (stale overrides may
 *    later become active again if discovery returns the item).
 *  - Operation payloads are parsed by `agentCapabilityOverrideOperationSchema`
 *    at the boundary, so malformed records throw before any work is done.
 */

import {
  agentCapabilityOverrideOperationSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityCascadeOverride,
  type AgentCapabilityCascadesOverride,
  type AgentCapabilityOverrideOperation,
  type AgentCapabilityOverrides,
} from "@/lib/schemas";

export interface ApplyCapabilityOperationsInput {
  current: AgentCapabilityOverrides;
  cascadeKind: AgentCapabilityCascadeKind;
  operations: readonly AgentCapabilityOverrideOperation[];
}

export interface ApplyCapabilityOperationsResult {
  overrides: AgentCapabilityOverrides;
  changedItemIds: readonly string[];
}

export function applyCapabilityOperations(
  input: ApplyCapabilityOperationsInput,
): ApplyCapabilityOperationsResult {
  const parsedOps = input.operations.map((op, index) => {
    const result = agentCapabilityOverrideOperationSchema.safeParse(op);
    if (!result.success) {
      throw new Error(
        `Invalid agent capability override operation at index ${index}: ${result.error.message}`,
      );
    }
    return result.data;
  });

  const nextCascades = cloneCascades(input.current.cascades);
  const changed = new Set<string>();

  let cascade = cloneCascade(nextCascades[input.cascadeKind]);

  for (const op of parsedOps) {
    const before = cascade?.items[op.itemId];

    if (op.type === "reset-item") {
      if (before === undefined) continue;
      const items = { ...(cascade?.items ?? {}) };
      delete items[op.itemId];
      cascade = Object.keys(items).length === 0 ? undefined : { items };
      changed.add(op.itemId);
      continue;
    }

    if (before !== undefined && before.enabled === op.enabled) continue;

    const items = {
      ...(cascade?.items ?? {}),
      [op.itemId]: { enabled: op.enabled },
    };
    cascade = { items };
    changed.add(op.itemId);
  }

  if (cascade === undefined) {
    delete nextCascades[input.cascadeKind];
  } else {
    nextCascades[input.cascadeKind] = cascade;
  }

  return {
    overrides: { cascades: nextCascades },
    changedItemIds: Array.from(changed),
  };
}

function cloneCascades(
  cascades: AgentCapabilityCascadesOverride,
): AgentCapabilityCascadesOverride {
  const out: AgentCapabilityCascadesOverride = {};
  for (const [key, value] of Object.entries(cascades) as Array<
    [AgentCapabilityCascadeKind, AgentCapabilityCascadeOverride | undefined]
  >) {
    if (value === undefined) continue;
    out[key] = cloneCascade(value);
  }
  return out;
}

function cloneCascade(
  cascade: AgentCapabilityCascadeOverride | undefined,
): AgentCapabilityCascadeOverride | undefined {
  if (cascade === undefined) return undefined;
  const items: Record<string, { enabled: boolean }> = {};
  for (const [itemId, item] of Object.entries(cascade.items)) {
    items[itemId] = { enabled: item.enabled };
  }
  return { items };
}
