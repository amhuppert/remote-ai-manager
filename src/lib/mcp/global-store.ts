import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveConfigDir } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import {
  mcpGlobalStateSchema,
  type McpOverrideOperation,
  type McpOverrides,
} from "@/lib/schemas";

import { applyOperations } from "./overrides-patch";

export const MCP_GLOBAL_STATE_FILENAME = "mcp-global.json";

export function getDefaultGlobalOverridesPath(): string {
  return path.join(resolveConfigDir(), MCP_GLOBAL_STATE_FILENAME);
}

const logger = createLogger("mcp.override-store");

export interface GlobalOverrideStoreDeps {
  /** Absolute path to the JSON file used to persist global overrides. */
  filePath: string;
}

export interface GlobalOverridePatchInput {
  operations: readonly McpOverrideOperation[];
}

export interface GlobalOverridePatchResult {
  overrides: McpOverrides;
  changedServerKeys: readonly string[];
}

export interface GlobalOverrideStore {
  read(): Promise<McpOverrides>;
  patch(input: GlobalOverridePatchInput): Promise<GlobalOverridePatchResult>;
}

export function createGlobalOverrideStore(
  deps: GlobalOverrideStoreDeps,
): GlobalOverrideStore {
  const { filePath } = deps;

  async function read(): Promise<McpOverrides> {
    if (!existsSync(filePath)) {
      return emptyOverrides();
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      logger.error("global.read_failure", {
        filePath,
        error: getErrorMessage(err),
      });
      throw new Error(
        `Failed to read MCP global override file ${filePath}: ${getErrorMessage(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.error("global.parse_failure", {
        filePath,
        error: getErrorMessage(err),
      });
      throw new Error(
        `MCP global override file contains invalid JSON: ${getErrorMessage(err)}`,
      );
    }

    const result = mcpGlobalStateSchema.safeParse(parsed);
    if (!result.success) {
      logger.error("global.schema_validation_failure", {
        filePath,
        issueCount: result.error.issues.length,
      });
      throw new Error(
        `MCP global override file failed schema validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    return result.data.overrides;
  }

  async function patch(
    input: GlobalOverridePatchInput,
  ): Promise<GlobalOverridePatchResult> {
    const current = await read();
    const { overrides, changedServerKeys } = applyOperations(
      current,
      input.operations,
    );

    await writeAtomically(filePath, {
      version: 1,
      overrides,
      updatedAt: new Date().toISOString(),
    });

    logger.info("global.patch", {
      filePath,
      operationCount: input.operations.length,
      changedCount: changedServerKeys.length,
    });

    return { overrides, changedServerKeys };
  }

  return { read, patch };
}

/**
 * Default singleton store pointing at `<cc-config-dir>/mcp-global.json`.
 * Tests should create their own store via `createGlobalOverrideStore` with an
 * explicit `filePath`.
 */
export const defaultGlobalOverrideStore: GlobalOverrideStore =
  createGlobalOverrideStore({ filePath: getDefaultGlobalOverridesPath() });

function emptyOverrides(): McpOverrides {
  return { servers: {} };
}

async function writeAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}
