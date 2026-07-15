import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { renderCharterMarkdown, computeCharterHash } from "./render";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { createArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import type { ArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

const logger = createLogger("graph-workflow-charter-service");

const CHARTER_RELATIVE_PATH = path.posix.join(
  ".cc",
  "graph-workflow-docs",
  "charter.md",
);

const CHARTER_DESCRIPTION =
  "The workflow charter: the workflow-global source-of-truth precedence hierarchy and mission/conventions/non-goals narrative that governs this run.";

const CHARTER_READ_WHEN =
  "Read before resolving any source conflict — the ranked hierarchy decides which source prevails.";

export interface PublishCharterRegisteredInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  definitionId: string;
  definitionRevision: number;
  charterHash: string;
}

export interface WorkflowCharterServiceDeps {
  writeFile(absolutePath: string, contents: string | Uint8Array): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
  publishCharterRegistered(
    input: PublishCharterRegisteredInput,
  ): GraphWorkflowExecutionEvent[];
}

export interface SeedCharterInput {
  charter: WorkflowCharter;
  worktreePath: string;
  execution: GraphWorkflowExecution;
  projectPath: string;
  sessionName: string;
}

export interface SeedCharterResult {
  nextExecution: GraphWorkflowExecution;
  charterHash: string;
  events: GraphWorkflowExecutionEvent[];
}

export interface WorkflowCharterService {
  seedCharter(input: SeedCharterInput): Promise<SeedCharterResult>;
}

async function defaultWriteFile(
  absolutePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  await fs.writeFile(absolutePath, contents);
}

async function defaultEnsureDir(absolutePath: string): Promise<void> {
  await fs.mkdir(absolutePath, { recursive: true });
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

/**
 * Build an artifact registry whose registration callback pushes (or updates by
 * relativePath) a `kind:"charter"` shared-document entry onto the supplied
 * execution clone. The registry enforces worktree confinement, so the only
 * file ever written is the in-worktree charter.md — no source locator is
 * touched (6.2/6.4).
 */
function buildCharterRegistry(input: {
  deps: Pick<WorkflowCharterServiceDeps, "writeFile" | "ensureDir">;
  nextExecution: GraphWorkflowExecution;
  now: string;
  createDocumentId(): string;
}): ArtifactRegistry {
  const { deps, nextExecution, now, createDocumentId } = input;
  return createArtifactRegistry({
    writeFile: deps.writeFile,
    ensureDir: deps.ensureDir,
    logger: {
      info: (event, fields) => logger.info(event, fields),
      warn: (event, fields) => logger.warn(event, fields),
      error: (event, fields) => logger.error(event, fields),
    },
    registration: {
      async registerSharedDocument(reg) {
        const existingIndex = nextExecution.sharedDocuments.findIndex(
          (entry) => entry.relativePath === reg.relativePath,
        );

        if (existingIndex >= 0) {
          const existingEntry = nextExecution.sharedDocuments[existingIndex]!;
          nextExecution.sharedDocuments[existingIndex] = {
            ...existingEntry,
            relativePath: reg.relativePath,
            description: reg.description,
            readWhen: reg.readWhen,
            kind: "charter",
            updatedAt: now,
          };
          return;
        }

        nextExecution.sharedDocuments.push({
          id: createDocumentId(),
          relativePath: reg.relativePath,
          description: reg.description,
          readWhen: reg.readWhen,
          kind: "charter",
          createdAt: now,
          updatedAt: now,
          lastUpdatedByConversationId: null,
        });
      },
    },
  });
}

export function createWorkflowCharterService(
  deps: Partial<WorkflowCharterServiceDeps> & {
    publishCharterRegistered: WorkflowCharterServiceDeps["publishCharterRegistered"];
    now?: () => string;
    createDocumentId?: () => string;
  },
): WorkflowCharterService {
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const ensureDir = deps.ensureDir ?? defaultEnsureDir;
  const now = deps.now ?? (() => new Date().toISOString());
  const createDocumentId =
    deps.createDocumentId ?? (() => `doc-charter-${randomUUID()}`);

  async function seedCharter(
    input: SeedCharterInput,
  ): Promise<SeedCharterResult> {
    // Defensive validation: the charter is internal/trusted data already
    // accepted at definition time, but re-`parse` so a corrupted snapshot
    // halts the seed before the first iteration rather than reaching agents.
    const charter = workflowCharterSchema.parse(input.charter);

    const markdown = renderCharterMarkdown(charter);
    const charterHash = computeCharterHash(charter);

    // Operate on a clone — never mutate the caller's execution.
    const nextExecution = cloneExecution(input.execution);

    const registry = buildCharterRegistry({
      deps: { writeFile, ensureDir },
      nextExecution,
      now: now(),
      createDocumentId,
    });

    // Worktree confinement is enforced by the artifact registry: a path that
    // escapes the worktree throws ArtifactRequiredFailure here.
    await registry.write({
      kind: "graph_shared_document",
      worktreePath: input.worktreePath,
      relativePath: CHARTER_RELATIVE_PATH,
      contents: markdown,
      audience: "user_facing",
      description: CHARTER_DESCRIPTION,
      readWhen: CHARTER_READ_WHEN,
      source: { workflowId: nextExecution.id },
    });

    // Snapshot the charter onto the execution (2.4/7.4). Governance derives
    // from this immutable snapshot; the written charter.md is a read-only copy.
    nextExecution.charter = charter;

    getExecutionLogger(input.execution.id)?.lifecycle("charter.registered", {
      charterHash,
      definitionId: input.execution.seedDefinitionId,
      definitionRevision: input.execution.seedDefinitionRevision,
    });

    logger.info("graph-workflow.charter.registered", {
      executionId: input.execution.id,
      definitionId: input.execution.seedDefinitionId,
      definitionRevision: input.execution.seedDefinitionRevision,
      charterHash,
    });

    const events = deps.publishCharterRegistered({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: nextExecution,
      definitionId: input.execution.seedDefinitionId,
      definitionRevision: input.execution.seedDefinitionRevision,
      charterHash,
    });

    return { nextExecution, charterHash, events };
  }

  return { seedCharter };
}
