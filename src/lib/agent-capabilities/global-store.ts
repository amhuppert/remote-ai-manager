/**
 * Global agent-capability override persistence.
 *
 * A thin domain adapter over the shared scoped-config file store
 * (`@/lib/shared/scoped-config-store`), which owns the lazy file creation,
 * atomic temp-then-rename writes, pre-commit re-validation, the serialized
 * write tail, and the in-lock `precondition` hook (used by the mutation
 * service for atomic expected-hash conflict detection).
 *
 * This module keeps the domain semantics: the
 * `agentCapabilityGlobalStateSchema` file format, patch application via
 * `applyCapabilityOperations`, and error redaction via
 * `redactAgentCapabilityText`.
 */

import path from "node:path";

import { resolveConfigDir } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { createScopedConfigFileStore } from "@/lib/shared/scoped-config-store";
import {
  agentCapabilityGlobalStateSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityOverrideOperation,
  type AgentCapabilityOverrides,
} from "./schemas";

import { applyCapabilityOperations } from "./patch";
import { redactAgentCapabilityText } from "./redaction";

const AGENT_CAPABILITIES_GLOBAL_FILENAME = "agent-capabilities-global.json";

function getDefaultGlobalCapabilityOverridesPath(): string {
  return path.join(resolveConfigDir(), AGENT_CAPABILITIES_GLOBAL_FILENAME);
}

const logger = createLogger("agent-capabilities.global-store");

export interface GlobalCapabilityOverrideStoreDeps {
  filePath: string;
}

export interface GlobalCapabilityPatchInput {
  cascadeKind: AgentCapabilityCascadeKind;
  operations: readonly AgentCapabilityOverrideOperation[];
  /**
   * Optional guard run inside the serialized write boundary after the
   * current on-disk state has been read and before the new state is written.
   * Throwing from the precondition aborts the patch without persisting and
   * propagates the error to the caller. The mutation service uses this hook
   * for atomic expected-hash conflict detection.
   */
  precondition?(current: AgentCapabilityOverrides): Promise<void> | void;
}

interface GlobalCapabilityPatchResult {
  overrides: AgentCapabilityOverrides;
  changedItemIds: readonly string[];
}

export interface GlobalCapabilityOverrideStore {
  read(): Promise<AgentCapabilityOverrides>;
  patch(
    input: GlobalCapabilityPatchInput,
  ): Promise<GlobalCapabilityPatchResult>;
}

export function createGlobalCapabilityOverrideStore(
  deps: GlobalCapabilityOverrideStoreDeps,
): GlobalCapabilityOverrideStore {
  const store = createScopedConfigFileStore<AgentCapabilityOverrides>({
    filePath: deps.filePath,
    entityLabel: "agent capability global override",
    logEventPrefix: "global",
    logger,
    emptyOverrides: () => ({ cascades: {} }),
    decodeState: (parsed) => {
      const result = agentCapabilityGlobalStateSchema.safeParse(parsed);
      if (!result.success) {
        return {
          ok: false,
          error: result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        };
      }
      return { ok: true, overrides: result.data.overrides };
    },
    encodeState: (overrides) => ({
      version: 1 as const,
      overrides,
      updatedAt: new Date().toISOString(),
    }),
    sanitizeError: redactAgentCapabilityText,
  });

  async function patch(
    input: GlobalCapabilityPatchInput,
  ): Promise<GlobalCapabilityPatchResult> {
    const precondition = input.precondition;
    return store.patch<GlobalCapabilityPatchResult>({
      apply: (current) =>
        applyCapabilityOperations({
          current,
          cascadeKind: input.cascadeKind,
          operations: input.operations,
        }),
      ...(precondition
        ? { precondition: (current) => precondition.call(input, current) }
        : {}),
      logFields: (result) => ({
        cascadeKind: input.cascadeKind,
        operationCount: input.operations.length,
        changedCount: result.changedItemIds.length,
      }),
    });
  }

  return { read: store.read, patch };
}

export const defaultGlobalCapabilityOverrideStore: GlobalCapabilityOverrideStore =
  createGlobalCapabilityOverrideStore({
    filePath: getDefaultGlobalCapabilityOverridesPath(),
  });
