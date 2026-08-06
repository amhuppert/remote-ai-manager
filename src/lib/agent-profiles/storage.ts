/**
 * Scoped, revisioned storage for the mutable agent-profile tiers.
 *
 * The scoped-record shape mirrors the workflow template library
 * (`workflow-graph/storage.ts`): explicit `{kind:"global"}` / `{kind:"project"}`
 * scopes, one atomic JSON document per record, and a single-source tier→scope
 * mapping. What it adds is the piece that pattern lacks — a per-record mutex
 * serializing every create, read-check-write, and delete. `atomicWriteJson` is
 * atomic per write but explicitly does NOT serialize concurrent writes to one
 * target (last rename wins), so without this owner two callers would both read
 * revision N, both write N+1, and the compare-and-swap contract in R4 would be
 * decorative. The mutex is in-process, which is sufficient because the single
 * CC server process owns this config storage.
 *
 * A record that fails to parse is quarantined, never fatal: it is excluded from
 * listing and resolution and surfaced as a diagnostic naming the record and the
 * reason, while its siblings stay fully usable.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { getErrorMessage } from "@/lib/shared/errors";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";

import { computeContentHash } from "./hashing";
import {
  assertValidAgentProfileId,
  storedAgentProfileRecordSchema,
  type AgentProfileContent,
  type AgentProfileCreateInput,
  type MutableAgentProfileTier,
  type StoredAgentProfileRecord,
} from "./schemas";

const logger = createLogger("agent-profile-storage");

// ============================================================
// Scopes
// ============================================================

/**
 * Where a mutable record lives. `global` is one cross-project tier; `project`
 * is keyed by an opaque project path.
 */
export type AgentProfileScope =
  | { kind: "global" }
  | { kind: "project"; projectPath: string };

/**
 * Reserved directory key for the global tier. It contains a `.` — outside the
 * base64url alphabet (`A–Za–z0–9-_`) — so it can never equal
 * `base64url(projectPath)` for any project path, making a collision with a
 * per-project key structurally impossible rather than guarded at runtime.
 */
const GLOBAL_SCOPE_KEY = "global.shared";

const STORAGE_SUBDIR = "agent-profiles";

/**
 * Single source of the tier→scope mapping. Every caller that needs a scope for
 * a tier maps through here, so the correspondence lives in exactly one place.
 *
 * `projectPath` is nullable because some callers genuinely have no project in
 * scope — the global-scope API surface, the CLI outside a project. A null path
 * can address the global tier and only the global tier; asking it for the
 * project tier is refused here rather than resolved against an invented path,
 * which would file a project record under a scope key no project owns.
 */
export function scopeForMutableTier(
  tier: MutableAgentProfileTier,
  projectPath: string | null,
): AgentProfileScope {
  if (tier === "global") return { kind: "global" };
  if (projectPath === null) {
    throw new AgentProfileProjectScopeRequiredError();
  }
  return { kind: "project", projectPath };
}

/** The inverse of {@link scopeForMutableTier}, for provenance and messages. */
export function tierForScope(
  scope: AgentProfileScope,
): MutableAgentProfileTier {
  return scope.kind === "global" ? "global" : "project";
}

function scopeKey(scope: AgentProfileScope): string {
  return scope.kind === "global"
    ? GLOBAL_SCOPE_KEY
    : Buffer.from(scope.projectPath).toString("base64url");
}

// ============================================================
// Typed refusals
// ============================================================

/**
 * A project-tier operation attempted without a project in scope. This is a
 * refusal, not a lookup miss: there is no project the reference could belong
 * to, so no answer — not even "absent" — would be true of one.
 */
export class AgentProfileProjectScopeRequiredError extends Error {
  readonly code = "agent_profile_project_scope_required" as const;

  constructor() {
    super(
      "Project-tier agent profiles require a project in scope. Address them through the project-scoped surface.",
    );
    this.name = "AgentProfileProjectScopeRequiredError";
  }
}

export class AgentProfileNotFoundError extends Error {
  readonly code = "agent_profile_not_found" as const;

  constructor(
    readonly tier: MutableAgentProfileTier,
    readonly id: string,
  ) {
    super(`Agent profile ${tier}:${id} does not exist.`);
    this.name = "AgentProfileNotFoundError";
  }
}

export class AgentProfileIdConflictError extends Error {
  readonly code = "agent_profile_id_conflict" as const;

  constructor(
    readonly tier: MutableAgentProfileTier,
    readonly id: string,
  ) {
    super(
      `Agent profile id "${id}" is already taken in the ${tier} tier. Ids are unique within a tier; choose another.`,
    );
    this.name = "AgentProfileIdConflictError";
  }
}

/**
 * A compare-and-swap refusal. `winningRevision` is the revision actually on
 * disk, so a caller can re-read, rebase its edit, and retry without guessing.
 */
export class AgentProfileRevisionConflictError extends Error {
  readonly code = "agent_profile_revision_conflict" as const;

  constructor(
    readonly tier: MutableAgentProfileTier,
    readonly id: string,
    readonly expectedRevision: number,
    readonly winningRevision: number,
  ) {
    super(
      `Agent profile ${tier}:${id} changed: expected revision ${expectedRevision} but the stored revision is ${winningRevision}. Reload it and reapply your change.`,
    );
    this.name = "AgentProfileRevisionConflictError";
  }
}

// ============================================================
// Quarantine
// ============================================================

/** A stored record that could not be read, named so an operator can fix it. */
export interface AgentProfileQuarantineDiagnostic {
  /** The id the record's filename claims. */
  id: string;
  /** Why it was excluded — a parse or schema failure summary, never content. */
  reason: string;
}

export interface AgentProfileListing {
  records: StoredAgentProfileRecord[];
  diagnostics: AgentProfileQuarantineDiagnostic[];
}

// ============================================================
// Service
// ============================================================

export interface AgentProfileStorage {
  /** Every readable record in `scope`, plus a diagnostic per quarantined one. */
  list(scope: AgentProfileScope): Promise<AgentProfileListing>;
  /** The record, or null when it is absent OR quarantined (both fail closed). */
  get(
    scope: AgentProfileScope,
    id: string,
  ): Promise<StoredAgentProfileRecord | null>;
  create(
    scope: AgentProfileScope,
    input: AgentProfileCreateInput,
  ): Promise<StoredAgentProfileRecord>;
  update(
    scope: AgentProfileScope,
    id: string,
    expectedRevision: number,
    content: AgentProfileContent,
  ): Promise<StoredAgentProfileRecord>;
  delete(
    scope: AgentProfileScope,
    id: string,
    expectedRevision: number,
  ): Promise<void>;
}

export interface AgentProfileStorageDeps {
  resolveConfigDir?: () => string;
  now?: () => Date;
}

/**
 * Keyed by absolute record path and shared by every storage instance in the
 * process. A per-instance mutex would serialize nothing when two services are
 * constructed over the same config dir — which is exactly the situation the
 * compare-and-swap contract has to survive.
 */
const recordMutex = createKeyedMutex();

export function createAgentProfileStorage(
  deps: AgentProfileStorageDeps = {},
): AgentProfileStorage {
  const resolveConfigDir = deps.resolveConfigDir ?? getConfigDirPath;
  const now = deps.now ?? (() => new Date());

  function scopeDir(scope: AgentProfileScope): string {
    return path.join(resolveConfigDir(), STORAGE_SUBDIR, scopeKey(scope));
  }

  /**
   * Validate before any id reaches the filesystem: ids are kebab-case slugs, so
   * a rejected id can never contain a separator or `..` and address a path
   * outside its scope directory.
   */
  function recordPath(scope: AgentProfileScope, id: string): string {
    return path.join(scopeDir(scope), `${assertValidAgentProfileId(id)}.json`);
  }

  /**
   * Read the record filed under `storageKey`. Returns a reason instead of a
   * record when the document is unreadable — a corrupt record is quarantined,
   * so callers see "not resolvable" and never a partial or coerced profile;
   * `reason` is reported to `list` for the diagnostic.
   *
   * `storageKey` is not decoration: a record's identity is the key it is
   * addressed by, and a document is only that record if it agrees. Without the
   * check, an `alpha.json` declaring `id: "beta"` would list as `beta` and
   * answer a `get(scope, "alpha")` — one document holding two identities and
   * neither of them true.
   */
  async function readRecord(
    filePath: string,
    storageKey: string,
  ): Promise<
    | { ok: true; record: StoredAgentProfileRecord }
    | { ok: false; reason: string }
  > {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      return { ok: false, reason: `unreadable file: ${getErrorMessage(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: `invalid JSON: ${getErrorMessage(err)}` };
    }

    const decoded = storedAgentProfileRecordSchema.safeParse(parsed);
    if (!decoded.success) {
      return {
        ok: false,
        reason: `failed profile schema validation: ${decoded.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`,
          )
          .join("; ")}`,
      };
    }

    if (decoded.data.id !== storageKey) {
      return {
        ok: false,
        reason: `record declares id ${JSON.stringify(decoded.data.id)} but is stored under key ${JSON.stringify(storageKey)}; a record's id must match the key it is filed under`,
      };
    }

    return { ok: true, record: decoded.data };
  }

  async function list(scope: AgentProfileScope): Promise<AgentProfileListing> {
    const dir = scopeDir(scope);
    if (!existsSync(dir)) {
      return { records: [], diagnostics: [] };
    }

    const entries = (await readdir(dir)).filter((entry) =>
      entry.endsWith(".json"),
    );
    const records: StoredAgentProfileRecord[] = [];
    const diagnostics: AgentProfileQuarantineDiagnostic[] = [];

    for (const entry of entries) {
      const id = entry.slice(0, -".json".length);
      const result = await readRecord(path.join(dir, entry), id);
      if (result.ok) {
        records.push(result.record);
        continue;
      }
      diagnostics.push({ id, reason: result.reason });
      logger.warn("agent-profile-storage.quarantined", {
        tier: tierForScope(scope),
        profileId: id,
        reason: result.reason,
      });
    }

    return { records, diagnostics };
  }

  async function get(
    scope: AgentProfileScope,
    id: string,
  ): Promise<StoredAgentProfileRecord | null> {
    const storageKey = assertValidAgentProfileId(id);
    const filePath = recordPath(scope, storageKey);
    if (!existsSync(filePath)) return null;
    const result = await readRecord(filePath, storageKey);
    return result.ok ? result.record : null;
  }

  function buildRecord(
    id: string,
    revision: number,
    content: AgentProfileContent,
    createdAt: string,
  ): StoredAgentProfileRecord {
    return storedAgentProfileRecordSchema.parse({
      ...content,
      id,
      revision,
      sourceContentHash: computeContentHash(content.instructions),
      createdAt,
      updatedAt: now().toISOString(),
    });
  }

  async function create(
    scope: AgentProfileScope,
    input: AgentProfileCreateInput,
  ): Promise<StoredAgentProfileRecord> {
    const { id, ...content } = input;
    const filePath = recordPath(scope, id);

    return recordMutex.run(filePath, async () => {
      // Existence, not readability: a quarantined record still owns its id, so
      // a create must not silently overwrite bytes an operator has yet to
      // inspect. Checked inside the lock — outside it, two creates would both
      // see a free id and the second would clobber the first.
      if (existsSync(filePath)) {
        throw new AgentProfileIdConflictError(tierForScope(scope), id);
      }

      const record = buildRecord(id, 1, content, now().toISOString());
      await atomicWriteJson(filePath, record);
      logger.info("agent-profile-storage.created", {
        tier: tierForScope(scope),
        profileId: id,
      });
      return record;
    });
  }

  /** Load the record a compare-and-swap addresses, or throw its typed refusal. */
  async function loadForSwap(
    scope: AgentProfileScope,
    id: string,
    expectedRevision: number,
  ): Promise<StoredAgentProfileRecord> {
    const existing = await get(scope, id);
    if (existing === null) {
      throw new AgentProfileNotFoundError(tierForScope(scope), id);
    }
    if (existing.revision !== expectedRevision) {
      throw new AgentProfileRevisionConflictError(
        tierForScope(scope),
        id,
        expectedRevision,
        existing.revision,
      );
    }
    return existing;
  }

  async function update(
    scope: AgentProfileScope,
    id: string,
    expectedRevision: number,
    content: AgentProfileContent,
  ): Promise<StoredAgentProfileRecord> {
    const filePath = recordPath(scope, id);

    // The read, the revision check, and the write are one critical section:
    // split them and two callers both read revision N and both write N+1.
    return recordMutex.run(filePath, async () => {
      const existing = await loadForSwap(scope, id, expectedRevision);
      const record = buildRecord(
        id,
        existing.revision + 1,
        content,
        existing.createdAt,
      );
      await atomicWriteJson(filePath, record);
      logger.info("agent-profile-storage.updated", {
        tier: tierForScope(scope),
        profileId: id,
        revision: record.revision,
      });
      return record;
    });
  }

  async function remove(
    scope: AgentProfileScope,
    id: string,
    expectedRevision: number,
  ): Promise<void> {
    const filePath = recordPath(scope, id);

    // Delete is compare-and-swap too, and shares the update's critical section:
    // a concurrent update and delete must produce exactly one winner.
    return recordMutex.run(filePath, async () => {
      await loadForSwap(scope, id, expectedRevision);
      await rm(filePath, { force: true });
      logger.info("agent-profile-storage.deleted", {
        tier: tierForScope(scope),
        profileId: id,
      });
    });
  }

  return { list, get, create, update, delete: remove };
}
