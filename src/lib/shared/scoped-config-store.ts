/**
 * File-backed scoped-config store substrate — the shared persistence engine
 * under the per-scope config cascades (agent-capabilities global overrides,
 * MCP global overrides).
 *
 * Extracted from the agent-capabilities global store, the implementation that
 * proved why every layer of this design is needed:
 *
 *   - The file is created lazily on the first successful write; until then
 *     `read()` returns the domain's empty overrides without touching the
 *     filesystem.
 *   - Writes are atomic (temp-then-rename) with best-effort temp cleanup, and
 *     the assembled payload is re-validated through the domain codec before
 *     the rename, so a state that would not pass `read()` on the next boot is
 *     never committed.
 *   - All writes (`patch` and `replace`) are serialized through a per-store
 *     promise-chain mutex, so the read → optional-precondition → apply →
 *     write sequence executes atomically with respect to other writes on the
 *     same file. Without this, two concurrent patches both read the same
 *     snapshot and the second write silently drops the first (lost update).
 *   - `precondition` runs inside the lock after the read and before the
 *     write; throwing aborts the patch without persisting and propagates to
 *     the caller (used for atomic expected-hash conflict detection).
 *
 * Domain semantics stay in the domains: schemas (via the decode/encode
 * codec), patch-application logic (via `apply`), error redaction (via
 * `sanitizeError`), and log field vocabulary (via the injected logger and
 * `logFields`).
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { getErrorMessage } from "@/lib/shared/errors";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";

export interface ScopedConfigStoreLogger {
  info(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export interface ScopedConfigFileStoreDeps<TOverrides> {
  /** Absolute path to the JSON file that persists this scope's overrides. */
  filePath: string;
  /**
   * Mid-sentence entity label used in error messages, e.g.
   * `"agent capability global override"` → "Failed to read agent capability
   * global override file …".
   */
  entityLabel: string;
  /**
   * Prefix for structured-log event names, e.g. `"global"` →
   * `global.read_failure`, `global.patch`.
   */
  logEventPrefix: string;
  logger: ScopedConfigStoreLogger;
  /** The domain's empty-overrides value returned before the file exists. */
  emptyOverrides(): TOverrides;
  /**
   * Validate a parsed on-disk payload through the domain schema. `error` is
   * the preformatted issue summary appended to the thrown message.
   */
  decodeState(
    parsed: unknown,
  ): { ok: true; overrides: TOverrides } | { ok: false; error: string };
  /**
   * Assemble the full persisted payload for `overrides` (version envelope,
   * `updatedAt` stamp). The result is re-validated via `decodeState` before
   * the atomic write commits.
   */
  encodeState(overrides: TOverrides): unknown;
  /**
   * Sanitize error text before it reaches logs or thrown messages (e.g.
   * domain redaction). Defaults to the identity.
   */
  sanitizeError?(message: string): string;
}

export interface ScopedConfigPatchOptions<
  TOverrides,
  TResult extends { overrides: TOverrides },
> {
  /** Pure domain patch: current overrides → new overrides + domain result. */
  apply(current: TOverrides): TResult;
  /**
   * Optional guard run inside the serialized write boundary after the current
   * on-disk state has been read and before the new state is written. Throwing
   * aborts the patch without persisting and propagates to the caller.
   */
  precondition?(current: TOverrides): Promise<void> | void;
  /** Extra structured-log fields for the success log, derived from the result. */
  logFields?(result: TResult): Record<string, unknown>;
}

export interface ScopedConfigFileStore<TOverrides> {
  read(): Promise<TOverrides>;
  patch<TResult extends { overrides: TOverrides }>(
    options: ScopedConfigPatchOptions<TOverrides, TResult>,
  ): Promise<TResult>;
  /** Serialized whole-value replace through the same write mutex as `patch`. */
  replace(overrides: TOverrides): Promise<void>;
}

function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

export function createScopedConfigFileStore<TOverrides>(
  deps: ScopedConfigFileStoreDeps<TOverrides>,
): ScopedConfigFileStore<TOverrides> {
  const { filePath, entityLabel, logEventPrefix, logger } = deps;
  const sanitize = (message: string): string =>
    deps.sanitizeError ? deps.sanitizeError(message) : message;

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

  async function read(): Promise<TOverrides> {
    if (!existsSync(filePath)) {
      return deps.emptyOverrides();
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      const message = sanitize(getErrorMessage(err));
      logger.error(`${logEventPrefix}.read_failure`, {
        filePath,
        error: message,
      });
      throw new Error(
        `Failed to read ${entityLabel} file ${filePath}: ${message}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = sanitize(getErrorMessage(err));
      logger.error(`${logEventPrefix}.parse_failure`, {
        filePath,
        error: message,
      });
      throw new Error(
        `${capitalizeFirst(entityLabel)} file contains invalid JSON: ${message}`,
      );
    }

    const decoded = deps.decodeState(parsed);
    if (!decoded.ok) {
      logger.error(`${logEventPrefix}.schema_validation_failure`, {
        filePath,
        error: decoded.error,
      });
      throw new Error(
        `${capitalizeFirst(entityLabel)} file failed schema validation: ${decoded.error}`,
      );
    }

    return decoded.overrides;
  }

  async function validateAndWrite(overrides: TOverrides): Promise<void> {
    const payload = deps.encodeState(overrides);

    // Re-validate the assembled payload before committing so we never write
    // a file that wouldn't pass read() on the next process boot.
    const validated = deps.decodeState(payload);
    if (!validated.ok) {
      logger.error(`${logEventPrefix}.write_validation_failure`, {
        filePath,
        error: validated.error,
      });
      throw new Error(
        `Refusing to persist ${entityLabel} state: ${validated.error}`,
      );
    }

    try {
      await atomicWriteJson(filePath, payload);
    } catch (err) {
      const message = sanitize(getErrorMessage(err));
      logger.error(`${logEventPrefix}.write_failure`, {
        filePath,
        error: message,
      });
      throw new Error(
        `Failed to persist ${entityLabel} file ${filePath}: ${message}`,
      );
    }
  }

  async function patch<TResult extends { overrides: TOverrides }>(
    options: ScopedConfigPatchOptions<TOverrides, TResult>,
  ): Promise<TResult> {
    return withWriteLock(async () => {
      const current = await read();

      if (options.precondition) {
        await options.precondition(current);
      }

      const result = options.apply(current);
      await validateAndWrite(result.overrides);

      logger.info(`${logEventPrefix}.patch`, {
        filePath,
        ...(options.logFields ? options.logFields(result) : {}),
      });

      return result;
    });
  }

  async function replace(overrides: TOverrides): Promise<void> {
    return withWriteLock(() => validateAndWrite(overrides));
  }

  return { read, patch, replace };
}
