/**
 * ArtifactRegistry primitive.
 *
 * Coordinates artifact writes and discoverability registration while preserving
 * the canonical paths and metadata systems already in use across the codebase:
 *
 *  - `memory-bank/focus.md`           — focus memory (registered as a reference
 *    document for the owning session).
 *  - `memory-bank/codex/...`          — Codex run output (filesystem-only).
 *  - `.cc/graph-workflow-docs/...`    — graph workflow shared documents
 *    (registered through the graph workflow shared-document registry).
 *  - `.cc/workflow/...`               — validation/script logs (filesystem
 *    only).
 *  - any worktree-relative path       — generic reference documents and
 *    workflow reports.
 *
 * Path resolution is kind-driven so new artifact kinds register a path rule
 * rather than inventing their own resolver. All resolution is rooted at the
 * caller-supplied session worktree path; absolute paths and relative paths
 * that escape the worktree are rejected.
 *
 * Failure handling is split into two entry points so callers express intent
 * explicitly:
 *
 *  - `write()`               — required artifact. Any write or registration
 *    failure throws `ArtifactRequiredFailure`, allowing the owning workflow to
 *    halt deliberately (Requirement 10.3).
 *  - `writeOptional()`       — optional artifact. Failures degrade to a
 *    warning outcome plus a structured warn-log so the workflow can continue
 *    (Requirement 10.4).
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const ARTIFACT_KINDS = [
  "reference_document",
  "focus_memory",
  "codex_output",
  "graph_shared_document",
  "validation_log",
  "workflow_report",
] as const;

export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

const ARTIFACT_AUDIENCES = ["user_facing", "internal_log"] as const;
const artifactAudienceSchema = z.enum(ARTIFACT_AUDIENCES);
type ArtifactAudience = z.infer<typeof artifactAudienceSchema>;

export interface ArtifactKindPathRule {
  /** Locked, canonical path for kinds that resolve to a single fixed location (e.g. focus.md). */
  canonicalPath?: string;
  /** Required worktree-relative directory prefix for kinds that have a fixed home. */
  requiredBaseDir?: string;
  /** Whether this kind expects discoverability registration. */
  registration?: "reference_document" | "shared_document";
}

export const ARTIFACT_KIND_PATH_RULES: Record<
  ArtifactKind,
  ArtifactKindPathRule
> = {
  reference_document: { registration: "reference_document" },
  focus_memory: {
    canonicalPath: "memory-bank/focus.md",
    registration: "reference_document",
  },
  codex_output: { requiredBaseDir: "memory-bank/codex" },
  graph_shared_document: {
    requiredBaseDir: ".cc/graph-workflow-docs",
    registration: "shared_document",
  },
  validation_log: { requiredBaseDir: ".cc/workflow" },
  workflow_report: {},
};

const artifactSourceSchema = z.object({
  workflowId: z.string().min(1).optional(),
  laneId: z.string().min(1).optional(),
  round: z.number().int().nonnegative().optional(),
  createdAt: z.string().min(1),
});
type ArtifactSource = z.infer<typeof artifactSourceSchema>;

export const artifactRecordSchema = z.object({
  artifactId: z.string().min(1),
  kind: artifactKindSchema,
  relativePath: z.string().min(1),
  audience: artifactAudienceSchema,
  source: artifactSourceSchema,
});
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export interface ArtifactWriteRequest {
  kind: ArtifactKind;
  worktreePath: string;
  relativePath: string;
  contents: string | Uint8Array;
  audience: ArtifactAudience;
  required: boolean;
  source: {
    workflowId?: string;
    laneId?: string;
    round?: number;
  };
  description?: string;
  readWhen?: string;
}

export interface ArtifactWriteOptionalRequest {
  kind: ArtifactKind;
  worktreePath: string;
  relativePath: string;
  contents: string | Uint8Array;
  audience: ArtifactAudience;
  source: {
    workflowId?: string;
    laneId?: string;
    round?: number;
  };
  description?: string;
  readWhen?: string;
}

export type ArtifactWriteOutcome =
  | { status: "registered"; record: ArtifactRecord }
  | { status: "skipped_warning"; warning: string };

export interface ArtifactRegistration {
  registerReferenceDocument?(input: {
    worktreePath: string;
    relativePath: string;
    description: string;
    source: ArtifactSource;
  }): Promise<void>;
  registerSharedDocument?(input: {
    worktreePath: string;
    relativePath: string;
    description: string;
    readWhen: string;
    source: ArtifactSource;
  }): Promise<void>;
}

interface ArtifactRegistryLogger {
  info?(event: string, fields: Record<string, unknown>): void;
  warn?(event: string, fields: Record<string, unknown>): void;
  error?(event: string, fields: Record<string, unknown>): void;
}

export interface ArtifactRegistryDeps {
  writeFile(absolutePath: string, contents: string | Uint8Array): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
  now?(): string;
  newId?(): string;
  registration?: ArtifactRegistration;
  logger?: ArtifactRegistryLogger;
}

export interface ArtifactRegisterRequest {
  kind: ArtifactKind;
  worktreePath: string;
  relativePath: string;
  description: string;
  readWhen?: string;
  source: {
    workflowId?: string;
    laneId?: string;
    round?: number;
  };
}

export interface ArtifactRegistry {
  write(request: ArtifactWriteRequest): Promise<ArtifactRecord>;
  writeOptional(
    request: ArtifactWriteOptionalRequest,
  ): Promise<ArtifactWriteOutcome>;
  /**
   * Register an artifact that already exists on disk (e.g. a focus.md the user
   * authored manually) without rewriting its contents. Honors the same
   * registration target as `write()` — `reference_document` or
   * `shared_document` — and rejects kinds that are filesystem-only.
   */
  register(request: ArtifactRegisterRequest): Promise<ArtifactRecord>;
}

export const artifactRequiredFailureName = "ArtifactRequiredFailure";

export class ArtifactRequiredFailure extends Error {
  override name: string = artifactRequiredFailureName;
  readonly kind: ArtifactKind;
  readonly relativePath: string;
  readonly stage: "path_resolution" | "write" | "registration";
  readonly cause?: Error;

  constructor(input: {
    kind: ArtifactKind;
    relativePath: string;
    stage: "path_resolution" | "write" | "registration";
    message: string;
    cause?: Error;
  }) {
    super(input.message);
    this.kind = input.kind;
    this.relativePath = input.relativePath;
    this.stage = input.stage;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

function describeKindLocation(rule: ArtifactKindPathRule): string {
  if (rule.canonicalPath) return rule.canonicalPath;
  if (rule.requiredBaseDir) return `${rule.requiredBaseDir}/`;
  return "<worktree>";
}

function resolveCanonicalRelativePath(input: {
  kind: ArtifactKind;
  relativePath: string;
  worktreePath: string;
}): string {
  const rule = ARTIFACT_KIND_PATH_RULES[input.kind];

  if (!input.relativePath || input.relativePath.length === 0) {
    throw new Error(
      `relativePath is required for ${input.kind} (expected: ${describeKindLocation(rule)})`,
    );
  }

  if (path.isAbsolute(input.relativePath)) {
    throw new Error(
      `Absolute paths are not permitted for artifact writes; received ${input.relativePath}`,
    );
  }

  const worktreeAbsolute = path.resolve(input.worktreePath);
  const candidateAbsolute = path.resolve(worktreeAbsolute, input.relativePath);
  const normalizedRelative = path.relative(worktreeAbsolute, candidateAbsolute);

  if (
    normalizedRelative === ".." ||
    normalizedRelative.startsWith(`..${path.sep}`) ||
    normalizedRelative.length === 0 ||
    path.isAbsolute(normalizedRelative)
  ) {
    throw new Error(
      `Refusing to write artifact outside the session worktree (resolved ${normalizedRelative})`,
    );
  }

  if (rule.canonicalPath) {
    if (normalizeRelative(normalizedRelative) !== rule.canonicalPath) {
      throw new Error(
        `Artifact kind ${input.kind} must use the canonical path ${rule.canonicalPath}; received ${normalizedRelative}`,
      );
    }
    return rule.canonicalPath;
  }

  if (rule.requiredBaseDir) {
    const baseRelative = rule.requiredBaseDir;
    const insideBase =
      normalizedRelative === baseRelative ||
      normalizedRelative.startsWith(`${baseRelative}${path.sep}`) ||
      normalizedRelative.startsWith(`${baseRelative}/`);
    if (!insideBase) {
      throw new Error(
        `Artifact kind ${input.kind} must be written under ${baseRelative}/; received ${normalizedRelative}`,
      );
    }
  }

  return normalizeRelative(normalizedRelative);
}

function normalizeRelative(relative: string): string {
  return relative.split(path.sep).join("/");
}

const noopLogger: Required<ArtifactRegistryLogger> = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function resolveLogger(
  override?: ArtifactRegistryLogger,
): Required<ArtifactRegistryLogger> {
  if (!override) return noopLogger;
  return {
    info: override.info ?? noopLogger.info,
    warn: override.warn ?? noopLogger.warn,
    error: override.error ?? noopLogger.error,
  };
}

export function createArtifactRegistry(
  deps: ArtifactRegistryDeps,
): ArtifactRegistry {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => `art-${randomUUID()}`);
  const logger = resolveLogger(deps.logger);
  const registration = deps.registration ?? {};

  async function performWrite(
    request: ArtifactWriteRequest,
  ): Promise<ArtifactRecord> {
    const rule = ARTIFACT_KIND_PATH_RULES[request.kind];

    let canonicalRelative: string;
    try {
      canonicalRelative = resolveCanonicalRelativePath({
        kind: request.kind,
        relativePath: request.relativePath,
        worktreePath: request.worktreePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ArtifactRequiredFailure({
        kind: request.kind,
        relativePath: request.relativePath,
        stage: "path_resolution",
        message,
        ...(err instanceof Error ? { cause: err } : {}),
      });
    }

    const willRegisterReferenceDocument =
      rule.registration === "reference_document" &&
      typeof registration.registerReferenceDocument === "function";
    const willRegisterSharedDocument =
      rule.registration === "shared_document" &&
      typeof registration.registerSharedDocument === "function";

    if (willRegisterReferenceDocument) {
      if (!request.description || request.description.trim().length === 0) {
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: `Artifact kind ${request.kind} requires a non-empty description for reference document registration`,
        });
      }
    }
    if (willRegisterSharedDocument) {
      if (
        !request.description ||
        request.description.trim().length === 0 ||
        !request.readWhen ||
        request.readWhen.trim().length === 0
      ) {
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: `Artifact kind ${request.kind} requires non-empty description and readWhen for shared document registration`,
        });
      }
    }

    const absolutePath = path.join(request.worktreePath, canonicalRelative);
    const parentDir = path.dirname(absolutePath);

    try {
      await deps.ensureDir(parentDir);
      await deps.writeFile(absolutePath, request.contents);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      logger.error("artifact-registry.write_failed", {
        kind: request.kind,
        relativePath: canonicalRelative,
        workflowId: request.source.workflowId,
        laneId: request.source.laneId,
        error: cause.message,
      });
      throw new ArtifactRequiredFailure({
        kind: request.kind,
        relativePath: canonicalRelative,
        stage: "write",
        message: cause.message,
        cause,
      });
    }

    const source: ArtifactSource = artifactSourceSchema.parse({
      ...(request.source.workflowId !== undefined
        ? { workflowId: request.source.workflowId }
        : {}),
      ...(request.source.laneId !== undefined
        ? { laneId: request.source.laneId }
        : {}),
      ...(request.source.round !== undefined
        ? { round: request.source.round }
        : {}),
      createdAt: now(),
    });

    if (willRegisterReferenceDocument) {
      try {
        await registration.registerReferenceDocument!({
          worktreePath: request.worktreePath,
          relativePath: canonicalRelative,
          description: request.description!,
          source,
        });
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        logger.error("artifact-registry.registration_failed", {
          kind: request.kind,
          relativePath: canonicalRelative,
          workflowId: request.source.workflowId,
          target: "reference_document",
          error: cause.message,
        });
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: cause.message,
          cause,
        });
      }
    } else if (willRegisterSharedDocument) {
      try {
        await registration.registerSharedDocument!({
          worktreePath: request.worktreePath,
          relativePath: canonicalRelative,
          description: request.description!,
          readWhen: request.readWhen!,
          source,
        });
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        logger.error("artifact-registry.registration_failed", {
          kind: request.kind,
          relativePath: canonicalRelative,
          workflowId: request.source.workflowId,
          target: "shared_document",
          error: cause.message,
        });
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: cause.message,
          cause,
        });
      }
    }

    const record = artifactRecordSchema.parse({
      artifactId: newId(),
      kind: request.kind,
      relativePath: canonicalRelative,
      audience: request.audience,
      source,
    });

    logger.info("artifact-registry.registered", {
      kind: record.kind,
      relativePath: record.relativePath,
      workflowId: record.source.workflowId,
      laneId: record.source.laneId,
      audience: record.audience,
    });

    return record;
  }

  async function write(request: ArtifactWriteRequest): Promise<ArtifactRecord> {
    return performWrite(request);
  }

  async function register(
    request: ArtifactRegisterRequest,
  ): Promise<ArtifactRecord> {
    const rule = ARTIFACT_KIND_PATH_RULES[request.kind];

    let canonicalRelative: string;
    try {
      canonicalRelative = resolveCanonicalRelativePath({
        kind: request.kind,
        relativePath: request.relativePath,
        worktreePath: request.worktreePath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ArtifactRequiredFailure({
        kind: request.kind,
        relativePath: request.relativePath,
        stage: "path_resolution",
        message,
        ...(err instanceof Error ? { cause: err } : {}),
      });
    }

    const willRegisterReferenceDocument =
      rule.registration === "reference_document" &&
      typeof registration.registerReferenceDocument === "function";
    const willRegisterSharedDocument =
      rule.registration === "shared_document" &&
      typeof registration.registerSharedDocument === "function";

    if (!willRegisterReferenceDocument && !willRegisterSharedDocument) {
      throw new ArtifactRequiredFailure({
        kind: request.kind,
        relativePath: canonicalRelative,
        stage: "registration",
        message: `Artifact kind ${request.kind} has no registration target; use write() instead`,
      });
    }

    if (willRegisterReferenceDocument) {
      if (!request.description || request.description.trim().length === 0) {
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: `Artifact kind ${request.kind} requires a non-empty description for reference document registration`,
        });
      }
    }
    if (willRegisterSharedDocument) {
      if (
        !request.description ||
        request.description.trim().length === 0 ||
        !request.readWhen ||
        request.readWhen.trim().length === 0
      ) {
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: `Artifact kind ${request.kind} requires non-empty description and readWhen for shared document registration`,
        });
      }
    }

    const source: ArtifactSource = artifactSourceSchema.parse({
      ...(request.source.workflowId !== undefined
        ? { workflowId: request.source.workflowId }
        : {}),
      ...(request.source.laneId !== undefined
        ? { laneId: request.source.laneId }
        : {}),
      ...(request.source.round !== undefined
        ? { round: request.source.round }
        : {}),
      createdAt: now(),
    });

    if (willRegisterReferenceDocument) {
      try {
        await registration.registerReferenceDocument!({
          worktreePath: request.worktreePath,
          relativePath: canonicalRelative,
          description: request.description,
          source,
        });
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        logger.error("artifact-registry.registration_failed", {
          kind: request.kind,
          relativePath: canonicalRelative,
          workflowId: request.source.workflowId,
          target: "reference_document",
          error: cause.message,
        });
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: cause.message,
          cause,
        });
      }
    } else if (willRegisterSharedDocument) {
      try {
        await registration.registerSharedDocument!({
          worktreePath: request.worktreePath,
          relativePath: canonicalRelative,
          description: request.description,
          readWhen: request.readWhen!,
          source,
        });
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        logger.error("artifact-registry.registration_failed", {
          kind: request.kind,
          relativePath: canonicalRelative,
          workflowId: request.source.workflowId,
          target: "shared_document",
          error: cause.message,
        });
        throw new ArtifactRequiredFailure({
          kind: request.kind,
          relativePath: canonicalRelative,
          stage: "registration",
          message: cause.message,
          cause,
        });
      }
    }

    const record = artifactRecordSchema.parse({
      artifactId: newId(),
      kind: request.kind,
      relativePath: canonicalRelative,
      audience: "user_facing",
      source,
    });

    logger.info("artifact-registry.registered_existing", {
      kind: record.kind,
      relativePath: record.relativePath,
      workflowId: record.source.workflowId,
      laneId: record.source.laneId,
    });

    return record;
  }

  async function writeOptional(
    request: ArtifactWriteOptionalRequest,
  ): Promise<ArtifactWriteOutcome> {
    try {
      const record = await performWrite({
        ...request,
        required: false,
      });
      return { status: "registered", record };
    } catch (err) {
      if (err instanceof ArtifactRequiredFailure) {
        const warning = err.message;
        logger.warn("artifact-registry.optional_skipped", {
          kind: request.kind,
          relativePath: request.relativePath,
          workflowId: request.source.workflowId,
          laneId: request.source.laneId,
          stage: err.stage,
          warning,
        });
        return { status: "skipped_warning", warning };
      }
      throw err;
    }
  }

  return { write, writeOptional, register };
}
