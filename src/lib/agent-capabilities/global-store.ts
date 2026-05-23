/**
 * Global agent-capability override persistence.
 *
 * Stores the global layer's `AgentCapabilityOverrides` in a single JSON file
 * inside the OS-aware Command Center config directory. The file is created
 * lazily on the first successful write; until then `read()` returns empty
 * overrides without touching the filesystem.
 *
 * Writes are atomic (temp-then-rename) and the freshly written file is
 * re-validated via `agentCapabilityGlobalStateSchema.parse()` before success
 * is reported, so a corrupted disk image cannot be silently committed.
 *
 * Read, parse, and write failures are surfaced as sanitized errors (no raw
 * payload echoed) and logged with structured context (`global.read_failure`,
 * `global.parse_failure`, `global.schema_validation_failure`,
 * `global.write_validation_failure`, `global.write_failure`). A failed write
 * never replaces the prior on-disk state because the rename only fires after
 * a successful temp-file write.
 *
 * Writes are serialized through a per-store promise-chain mutex so the
 * read → optional-precondition → apply → write sequence executes
 * atomically with respect to other patches on the same file. Callers may
 * supply an `precondition` that runs inside the lock after the read but
 * before the write; throwing from the precondition aborts the patch without
 * persisting and propagates the error to the caller (used by the mutation
 * service for atomic expected-hash conflict detection).
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { resolveConfigDir } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import {
  agentCapabilityGlobalStateSchema,
  type AgentCapabilityCascadeKind,
  type AgentCapabilityOverrideOperation,
  type AgentCapabilityOverrides,
} from "@/lib/schemas";

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
  const { filePath } = deps;
  let writeTail: Promise<unknown> = Promise.resolve();

  async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const predecessor = writeTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeTail = gate;
    try {
      await predecessor;
    } catch {
      // Predecessor's error is reported to its own caller; we still proceed.
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function read(): Promise<AgentCapabilityOverrides> {
    if (!existsSync(filePath)) {
      return emptyOverrides();
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      const message = redactAgentCapabilityText(getErrorMessage(err));
      logger.error("global.read_failure", {
        filePath,
        error: message,
      });
      throw new Error(
        `Failed to read agent capability global override file ${filePath}: ${message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = redactAgentCapabilityText(getErrorMessage(err));
      logger.error("global.parse_failure", {
        filePath,
        error: message,
      });
      throw new Error(
        `Agent capability global override file contains invalid JSON: ${message}`,
      );
    }

    const result = agentCapabilityGlobalStateSchema.safeParse(parsed);
    if (!result.success) {
      logger.error("global.schema_validation_failure", {
        filePath,
        issueCount: result.error.issues.length,
      });
      throw new Error(
        `Agent capability global override file failed schema validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    return result.data.overrides;
  }

  async function patch(
    input: GlobalCapabilityPatchInput,
  ): Promise<GlobalCapabilityPatchResult> {
    return withWriteLock(async () => {
      const current = await read();

      if (input.precondition) {
        await input.precondition(current);
      }

      const { overrides, changedItemIds } = applyCapabilityOperations({
        current,
        cascadeKind: input.cascadeKind,
        operations: input.operations,
      });

      const payload = {
        version: 1 as const,
        overrides,
        updatedAt: new Date().toISOString(),
      };

      // Re-validate the assembled record before committing so we never write
      // a file that wouldn't pass read() on the next process boot.
      const validated = agentCapabilityGlobalStateSchema.safeParse(payload);
      if (!validated.success) {
        logger.error("global.write_validation_failure", {
          filePath,
          issueCount: validated.error.issues.length,
        });
        throw new Error(
          `Refusing to persist agent capability global state: ${validated.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }

      try {
        await writeAtomically(filePath, validated.data);
      } catch (err) {
        const message = redactAgentCapabilityText(getErrorMessage(err));
        logger.error("global.write_failure", {
          filePath,
          error: message,
        });
        throw new Error(
          `Failed to persist agent capability global override file ${filePath}: ${message}`,
        );
      }

      logger.info("global.patch", {
        filePath,
        cascadeKind: input.cascadeKind,
        operationCount: input.operations.length,
        changedCount: changedItemIds.length,
      });

      return { overrides, changedItemIds };
    });
  }

  return { read, patch };
}

export const defaultGlobalCapabilityOverrideStore: GlobalCapabilityOverrideStore =
  createGlobalCapabilityOverrideStore({
    filePath: getDefaultGlobalCapabilityOverridesPath(),
  });

function emptyOverrides(): AgentCapabilityOverrides {
  return { cascades: {} };
}

async function writeAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of a stranded temp file so retries don't accumulate
    // detritus next to the canonical state file. The original failure is what
    // we surface to the caller.
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore: temp file may not exist (writeFile failure) or was renamed.
    }
    throw err;
  }
}
