/**
 * Global MCP override persistence.
 *
 * A thin domain adapter over the shared scoped-config file store
 * (`@/lib/shared/scoped-config-store`), which owns the lazy file creation,
 * atomic temp-then-rename writes, pre-commit re-validation, and the
 * serialized write tail — so concurrent patches can never lose an update by
 * reading the same snapshot and overwriting each other.
 *
 * Domain semantics stay here: the `mcpGlobalStateSchema` file format and
 * patch application via `applyOperations`.
 */

import path from "node:path";

import { resolveConfigDir } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { createScopedConfigFileStore } from "@/lib/shared/scoped-config-store";
import {
  mcpGlobalStateSchema,
  type McpOverrideOperation,
  type McpOverrides,
} from "@/lib/mcp/schemas";
import { applyOperations } from "./overrides-patch";

const MCP_GLOBAL_STATE_FILENAME = "mcp-global.json";

function getDefaultGlobalOverridesPath(): string {
  return path.join(resolveConfigDir(), MCP_GLOBAL_STATE_FILENAME);
}

const MCP_GLOBAL_DEFINITION_FILENAME = ".mcp.json";

export function getDefaultGlobalMcpDefinitionPath(): string {
  return path.join(resolveConfigDir(), MCP_GLOBAL_DEFINITION_FILENAME);
}

const logger = createLogger("mcp.override-store");

export interface GlobalOverrideStoreDeps {
  /** Absolute path to the JSON file used to persist global overrides. */
  filePath: string;
}

interface GlobalOverridePatchInput {
  operations: readonly McpOverrideOperation[];
  /**
   * Optional guard run inside the serialized write boundary after the current
   * on-disk overrides have been read and before the new state is written.
   * Throwing from the precondition aborts the patch without persisting and
   * propagates the error to the caller. The config-mutation service uses this
   * hook for atomic expected-hash conflict detection — the same mechanism the
   * agent-capability global store exposes.
   */
  precondition?(current: McpOverrides): Promise<void> | void;
}

interface GlobalOverridePatchResult {
  overrides: McpOverrides;
  changedServerKeys: readonly string[];
}

export interface GlobalOverrideStore {
  read(): Promise<McpOverrides>;
  patch(input: GlobalOverridePatchInput): Promise<GlobalOverridePatchResult>;
  replace(overrides: McpOverrides): Promise<void>;
}

export function createGlobalOverrideStore(
  deps: GlobalOverrideStoreDeps,
): GlobalOverrideStore {
  const store = createScopedConfigFileStore<McpOverrides>({
    filePath: deps.filePath,
    entityLabel: "MCP global override",
    logEventPrefix: "global",
    logger,
    emptyOverrides: () => ({ servers: {} }),
    decodeState: (parsed) => {
      const result = mcpGlobalStateSchema.safeParse(parsed);
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
  });

  async function patch(
    input: GlobalOverridePatchInput,
  ): Promise<GlobalOverridePatchResult> {
    const precondition = input.precondition;
    return store.patch<GlobalOverridePatchResult>({
      apply: (current) => applyOperations(current, input.operations),
      ...(precondition
        ? { precondition: (current) => precondition.call(input, current) }
        : {}),
      logFields: (result) => ({
        operationCount: input.operations.length,
        changedCount: result.changedServerKeys.length,
      }),
    });
  }

  return { read: store.read, patch, replace: store.replace };
}

/**
 * Default singleton store pointing at `<cc-config-dir>/mcp-global.json`.
 * Tests should create their own store via `createGlobalOverrideStore` with an
 * explicit `filePath`.
 */
export const defaultGlobalOverrideStore: GlobalOverrideStore =
  createGlobalOverrideStore({ filePath: getDefaultGlobalOverridesPath() });
