/**
 * Scoped, revisioned storage for run templates: one atomic JSON document per
 * template under `<configDir>/run-templates/<scopeKey>/<id>.json`.
 *
 * The mechanics are the agent-profile library's (`agent-profiles/storage.ts`),
 * copied rather than shared: two record kinds do not yet justify a common
 * store. A process-wide mutex keyed by record path makes each create,
 * read-check-write and delete one critical section, since `atomicWriteJson`
 * is atomic per write but does not serialize two writers; without it two
 * saves at revision N would both write N+1. One CC server process owns the
 * config directory, so an in-process mutex suffices.
 *
 * An id is validated before it reaches a path. A document that cannot be read
 * is quarantined: listed as a diagnostic naming its file, never fatal to its
 * siblings, and still owning its id, so a create cannot overwrite bytes
 * nobody has inspected.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { getErrorMessage } from "@/lib/shared/errors";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";

import {
  runTemplateRecordSchema,
  type RunTemplateContent,
  type RunTemplateRecord,
} from "./document";
import type { RunTemplateTier } from "@/lib/runs/schemas";
import { runTemplateIdSchema } from "./schemas";

const logger = createLogger("run-template-storage");

export type RunTemplateScope =
  | { kind: "global" }
  | { kind: "project"; projectPath: string };

/**
 * The global tier's directory. Its `.` is outside the base64url alphabet, so
 * no project path's key can ever equal it.
 */
const GLOBAL_SCOPE_KEY = "global.shared";
const STORAGE_SUBDIR = "run-templates";

export function scopeForTier(
  tier: RunTemplateTier,
  projectPath: string,
): RunTemplateScope {
  return tier === "global"
    ? { kind: "global" }
    : { kind: "project", projectPath };
}

export function tierForScope(scope: RunTemplateScope): RunTemplateTier {
  return scope.kind === "global" ? "global" : "project";
}

function scopeKey(scope: RunTemplateScope): string {
  return scope.kind === "global"
    ? GLOBAL_SCOPE_KEY
    : Buffer.from(scope.projectPath).toString("base64url");
}

/** A template file that could not be read, named so a person can fix or remove it. */
export interface RunTemplateQuarantine {
  id: string;
  /** The file, absolute. */
  path: string;
  reason: string;
}

export interface RunTemplateListing {
  records: RunTemplateRecord[];
  diagnostics: RunTemplateQuarantine[];
}

/** Why a write did not happen; nothing was changed. */
export type RunTemplateStorageRefusal =
  | { code: "run_template_exists"; message: string }
  | { code: "run_template_not_found"; message: string }
  | {
      code: "run_template_revision_conflict";
      message: string;
      currentRevision: number;
    };

/** A read of one template by scope and id. */
export type RunTemplateRead =
  | { kind: "found"; record: RunTemplateRecord }
  | { kind: "absent" }
  /** Its file exists but cannot be read; it keeps its id until fixed or removed. */
  | { kind: "unreadable"; path: string; reason: string };

export type RunTemplateWrite =
  | { ok: true; record: RunTemplateRecord }
  | { ok: false; refusal: RunTemplateStorageRefusal };

export interface RunTemplateStorage {
  /** Every readable template in `scope`, and a diagnostic for each quarantined one. */
  list(scope: RunTemplateScope): Promise<RunTemplateListing>;
  /** The template; or its absence; or, when its file cannot be read, why and where. */
  get(scope: RunTemplateScope, id: string): Promise<RunTemplateRead>;
  create(
    scope: RunTemplateScope,
    id: string,
    content: RunTemplateContent,
  ): Promise<RunTemplateWrite>;
  update(
    scope: RunTemplateScope,
    id: string,
    expectedRevision: number,
    content: RunTemplateContent,
  ): Promise<RunTemplateWrite>;
  delete(
    scope: RunTemplateScope,
    id: string,
    expectedRevision: number,
  ): Promise<RunTemplateWrite>;
  /** Every scope that has a directory, for a question asked of every template. */
  listScopes(): Promise<RunTemplateScope[]>;
}

export interface RunTemplateStorageDeps {
  resolveConfigDir?(): string;
  now?(): Date;
}

/**
 * Keyed by absolute record path and shared by every storage instance in the
 * process, so two services over one config directory still serialize.
 */
const recordMutex = createKeyedMutex();

type ReadResult =
  | { kind: "record"; record: RunTemplateRecord }
  | { kind: "absent" }
  | { kind: "quarantined"; reason: string };

export function createRunTemplateStorage(
  deps: RunTemplateStorageDeps = {},
): RunTemplateStorage {
  const resolveConfigDir = deps.resolveConfigDir ?? getConfigDirPath;
  const now = deps.now ?? (() => new Date());

  const rootDir = () => path.join(resolveConfigDir(), STORAGE_SUBDIR);
  const scopeDir = (scope: RunTemplateScope) =>
    path.join(rootDir(), scopeKey(scope));

  /** Refuses an id that is not a template id before any path is built from it. */
  function recordPath(scope: RunTemplateScope, id: string): string {
    const parsed = runTemplateIdSchema.safeParse(id);
    if (!parsed.success)
      throw new Error(`Invalid run template id ${JSON.stringify(id)}`);
    return path.join(scopeDir(scope), `${parsed.data}.json`);
  }

  /** The document filed under `id`; it is that record only if it says so. */
  async function read(filePath: string, id: string): Promise<ReadResult> {
    if (!existsSync(filePath)) return { kind: "absent" };
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (error) {
      return {
        kind: "quarantined",
        reason: `unreadable file: ${getErrorMessage(error)}`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return {
        kind: "quarantined",
        reason: `invalid JSON: ${getErrorMessage(error)}`,
      };
    }
    const decoded = runTemplateRecordSchema.safeParse(json);
    if (!decoded.success)
      return {
        kind: "quarantined",
        reason: `not a run template: ${decoded.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`,
          )
          .join("; ")}`,
      };
    if (decoded.data.id !== id)
      return {
        kind: "quarantined",
        reason: `it declares id ${JSON.stringify(decoded.data.id)} but is filed as ${JSON.stringify(id)}`,
      };
    return { kind: "record", record: decoded.data };
  }

  function notFound(
    scope: RunTemplateScope,
    id: string,
    filePath: string,
    found: ReadResult,
  ): RunTemplateWrite {
    const tier = tierForScope(scope);
    return {
      ok: false,
      refusal: {
        code: "run_template_not_found",
        message:
          found.kind === "quarantined"
            ? `Run template ${tier}:${id} cannot be read (${found.reason}); fix or remove ${filePath}`
            : `Run template ${tier}:${id} does not exist`,
      },
    };
  }

  /** The record a compare-and-swap addresses, or the refusal that leaves it alone. */
  async function loadForSwap(
    scope: RunTemplateScope,
    id: string,
    filePath: string,
    expectedRevision: number,
  ): Promise<RunTemplateWrite> {
    const found = await read(filePath, id);
    if (found.kind !== "record") return notFound(scope, id, filePath, found);
    if (found.record.revision !== expectedRevision)
      return {
        ok: false,
        refusal: {
          code: "run_template_revision_conflict",
          message: `Run template ${tierForScope(scope)}:${id} is at revision ${found.record.revision}, not ${expectedRevision}; read it again and reapply your change`,
          currentRevision: found.record.revision,
        },
      };
    return { ok: true, record: found.record };
  }

  function build(
    id: string,
    revision: number,
    content: RunTemplateContent,
    createdAt: string,
  ): RunTemplateRecord {
    return runTemplateRecordSchema.parse({
      ...content,
      format: 1,
      id,
      revision,
      createdAt,
      updatedAt: now().toISOString(),
    });
  }

  return {
    async list(scope) {
      const dir = scopeDir(scope);
      if (!existsSync(dir)) return { records: [], diagnostics: [] };
      const files = (await readdir(dir))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
      const records: RunTemplateRecord[] = [];
      const diagnostics: RunTemplateQuarantine[] = [];
      for (const file of files) {
        const id = file.slice(0, -".json".length);
        const filePath = path.join(dir, file);
        const found = await read(filePath, id);
        if (found.kind === "record") records.push(found.record);
        if (found.kind !== "quarantined") continue;
        diagnostics.push({ id, path: filePath, reason: found.reason });
        logger.warn("run-template-storage.quarantined", {
          tier: tierForScope(scope),
          templateId: id,
          path: filePath,
          reason: found.reason,
        });
      }
      return { records, diagnostics };
    },

    async get(scope, id) {
      const filePath = recordPath(scope, id);
      const found = await read(filePath, id);
      if (found.kind === "record")
        return { kind: "found", record: found.record };
      if (found.kind === "absent") return { kind: "absent" };
      return { kind: "unreadable", path: filePath, reason: found.reason };
    },

    async create(scope, id, content) {
      const filePath = recordPath(scope, id);
      return recordMutex.run(filePath, async () => {
        // Existence, not readability: a quarantined file still owns its id.
        const found = await read(filePath, id);
        if (found.kind !== "absent") {
          const tier = tierForScope(scope);
          return {
            ok: false,
            refusal: {
              code: "run_template_exists",
              message:
                found.kind === "quarantined"
                  ? `Run template ${tier}:${id} already exists but cannot be read (${found.reason}); fix or remove ${filePath}`
                  : `Run template ${tier}:${id} already exists at revision ${found.record.revision}; replace it at that revision, or choose another id`,
            },
          };
        }
        const record = build(id, 1, content, now().toISOString());
        await atomicWriteJson(filePath, record);
        logger.info("run-template-storage.created", {
          tier: tierForScope(scope),
          templateId: id,
        });
        return { ok: true, record };
      });
    },

    async update(scope, id, expectedRevision, content) {
      const filePath = recordPath(scope, id);
      return recordMutex.run(filePath, async () => {
        const current = await loadForSwap(
          scope,
          id,
          filePath,
          expectedRevision,
        );
        if (!current.ok) return current;
        const record = build(
          id,
          current.record.revision + 1,
          content,
          current.record.createdAt,
        );
        await atomicWriteJson(filePath, record);
        logger.info("run-template-storage.updated", {
          tier: tierForScope(scope),
          templateId: id,
          revision: record.revision,
        });
        return { ok: true, record };
      });
    },

    async delete(scope, id, expectedRevision) {
      const filePath = recordPath(scope, id);
      return recordMutex.run(filePath, async () => {
        const current = await loadForSwap(
          scope,
          id,
          filePath,
          expectedRevision,
        );
        if (!current.ok) return current;
        await rm(filePath, { force: true });
        logger.info("run-template-storage.deleted", {
          tier: tierForScope(scope),
          templateId: id,
          revision: current.record.revision,
        });
        return current;
      });
    },

    async listScopes() {
      const root = rootDir();
      if (!existsSync(root)) return [];
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map(
          (entry): RunTemplateScope =>
            entry.name === GLOBAL_SCOPE_KEY
              ? { kind: "global" }
              : {
                  kind: "project",
                  projectPath: Buffer.from(entry.name, "base64url").toString(),
                },
        );
    },
  };
}
