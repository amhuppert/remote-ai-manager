import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface CapturedLog {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: unknown;
}

const capturedLogs: CapturedLog[] = [];

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "info", message, data }),
    debug: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "debug", message, data }),
    warn: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "warn", message, data }),
    error: (message: string, data?: unknown) =>
      capturedLogs.push({ level: "error", message, data }),
  }),
}));

import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type {
  PersistedSourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import { renderCharterPromptSection } from "./charter/render";
import { workflowDefinitionRecordSchema } from "./definition-schemas";
import { graphWorkflowExecutionSchema } from "./schemas";
import { createWorkflowStorageService } from "./storage";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "./test-fixtures";
import { workingDefinitionHash } from "./working-definition-hash";

/**
 * The compatibility contract for charters persisted BEFORE structured source
 * scoping: prose `appliesTo` and the retired `accessPolicy` (including
 * `external-readonly`) load without error, render as global/plain sources with
 * no permission-gated text, and are never written back in normalized shape —
 * the stored bytes and the workingDefinitionHash survive a load/render cycle
 * untouched. This is the no-read-renormalization invariant made executable:
 * a read-path perturbation of exactly this class is what fed the incident-3
 * hash-mismatch loop.
 */

// A pre-cutover source that carried BOTH legacy fields, in their most
// consequential values: prose applicability and the permission-gated access
// policy. The prompt path must treat it as global and render neither field.
const externalReadonlySource: PersistedSourceOfTruth = {
  rank: 3,
  id: "upstream-protocol-spec",
  label: "Upstream Protocol Spec",
  type: "spec",
  locator: "https://example.com/spec",
  description: "External authority that lives outside the worktree.",
  appliesTo: "protocol consumers only",
  accessPolicy: "external-readonly",
};

// makeTestCharter() is itself the legacy persisted shape (prose appliesTo on
// rank 1, accessPolicy worktree-relative on both sources); the third source
// adds the external-readonly variant so every retired value is exercised.
function makeLegacyFrozenCharter(): WorkflowCharter {
  const base = makeTestCharter();
  return makeTestCharter({
    sourcesOfTruth: [...base.sourcesOfTruth, externalReadonlySource],
  });
}

const LEGACY_SOURCE_LABELS = [
  "Approved design document",
  "Per-context acceptance criteria",
  "Upstream Protocol Spec",
];

// A context id no legacy prose scope could ever name: legacy applicability is
// treated as global, so every source must still render for it.
const RENDER_CONTEXT_ID = "context-verify";

function expectLegacySourcesRenderedAsGlobalPlain(section: string): void {
  for (const label of LEGACY_SOURCE_LABELS) {
    expect(section).toContain(label);
  }
  const lowered = section.toLowerCase();
  // Neither legacy field renders: no prose applies-to, no access policy, and
  // none of the retired permission-gated prompt bookkeeping.
  expect(section).not.toContain("protocol consumers only");
  expect(section).not.toContain("all execution contexts");
  expect(section).not.toContain("Access:");
  expect(lowered).not.toContain("access policy");
  expect(lowered).not.toContain("permission-gated");
  expect(lowered).not.toContain("read-only");
  expect(lowered).not.toContain("worktree-relative");
  expect(section).not.toContain("Amendment log");
}

describe("stored definition record with a legacy charter", () => {
  const PROJECT_PATH = "/legacy-charter-project";
  const WORKFLOW_ID = "workflow-legacy-1";

  let tempDir: string;
  let filePath: string;
  let storedBytes: string;

  // Parsed through the real record schema BEFORE writing so every schema
  // default is already materialized: the stored bytes are then exactly what a
  // current-writer row carries, and any post-load difference is attributable
  // to the read path alone.
  const record = workflowDefinitionRecordSchema.parse(
    createWorkflowDefinitionRecord({
      id: WORKFLOW_ID,
      definition: createWorkflowDefinition({
        charter: makeLegacyFrozenCharter(),
      }),
    }),
  );

  function storageForTempDir() {
    return createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
  }

  beforeEach(async () => {
    capturedLogs.length = 0;
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-legacy-charter-"));
    // Pre-written directly: the authored accept path (storage.create) refuses
    // legacy source shapes, so a legacy record can only exist as bytes already
    // on disk — which is precisely the population this contract protects.
    const scopeDir = path.join(
      tempDir,
      "workflows",
      Buffer.from(PROJECT_PATH).toString("base64url"),
    );
    await mkdir(scopeDir, { recursive: true });
    filePath = path.join(scopeDir, `${WORKFLOW_ID}.json`);
    storedBytes = JSON.stringify(record, null, 2);
    await writeFile(filePath, storedBytes, "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads without error and preserves both legacy fields verbatim", async () => {
    const loaded = await storageForTempDir().get(
      { kind: "project", projectPath: PROJECT_PATH },
      WORKFLOW_ID,
    );

    expect(loaded).not.toBeNull();
    expect(loaded?.definition.charter).toEqual(record.definition.charter);
    expect(loaded?.definition.charter.sourcesOfTruth[2]).toMatchObject({
      appliesTo: "protocol consumers only",
      accessPolicy: "external-readonly",
    });
  });

  it("renders the loaded charter with legacy sources as global and no permission-gated text", async () => {
    const loaded = await storageForTempDir().get(
      { kind: "project", projectPath: PROJECT_PATH },
      WORKFLOW_ID,
    );
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    expectLegacySourcesRenderedAsGlobalPlain(
      renderCharterPromptSection(loaded.definition.charter, RENDER_CONTEXT_ID),
    );
  });

  it("keeps the stored bytes and the workingDefinitionHash unchanged by a load/render cycle", async () => {
    // The compared bytes carry the legacy fields — the comparison has teeth.
    expect(storedBytes).toContain("external-readonly");
    const hashBefore = workingDefinitionHash(record.definition);

    const loaded = await storageForTempDir().get(
      { kind: "project", projectPath: PROJECT_PATH },
      WORKFLOW_ID,
    );
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    renderCharterPromptSection(loaded.definition.charter, RENDER_CONTEXT_ID);

    expect(workingDefinitionHash(loaded.definition)).toBe(hashBefore);
    expect(await readFile(filePath, "utf-8")).toBe(storedBytes);
  });
});

describe("frozen execution charter with legacy sources", () => {
  const PROJECT_PATH = "/legacy-charter-project";
  const SESSION_NAME = "session-legacy";
  const FROZEN_CONTEXT_ID = "context-implement";

  let fixture: PersistenceFixture;

  // Parsed through the real execution schema BEFORE persisting, for the same
  // reason as the definition record above: the seeded row is a current-writer
  // row whose only pre-cutover content is the charter shape under test. The
  // frozen per-context copy is the as-run charter a completed context keeps.
  function buildLegacyExecution() {
    const base = createResolvedWorkflowDefinition();
    return graphWorkflowExecutionSchema.parse(
      createWorkflowExecution({
        charter: makeLegacyFrozenCharter(),
        workingDefinition: {
          ...base,
          executionContexts: base.executionContexts.map((context) =>
            context.id === FROZEN_CONTEXT_ID
              ? { ...context, charter: makeLegacyFrozenCharter() }
              : context,
          ),
        },
      }),
    );
  }

  function readStoredRow(): { definitionJson: string; runtimeJson: string } {
    const row: unknown = fixture.db
      .prepare(
        `SELECT definition_json, runtime_json FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      )
      .get(PROJECT_PATH, SESSION_NAME);
    if (
      typeof row !== "object" ||
      row === null ||
      !("definition_json" in row) ||
      !("runtime_json" in row) ||
      typeof row.definition_json !== "string" ||
      typeof row.runtime_json !== "string"
    ) {
      throw new Error("expected a stored graph_workflow_executions row");
    }
    return {
      definitionJson: row.definition_json,
      runtimeJson: row.runtime_json,
    };
  }

  beforeEach(() => {
    capturedLogs.length = 0;
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    fixture.graphWorkflowExecutions.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      buildLegacyExecution(),
      "2026-08-18T00:00:00.000Z",
    );
  });

  afterEach(() => {
    fixture.close();
  });

  it("stores the legacy charter shape and loads it back verbatim without rewriting it", () => {
    const before = readStoredRow();
    // The fixture actually carries the pre-cutover shape on disk — without
    // this, every assertion below would hold vacuously.
    expect(readStoredRow().definitionJson).toContain("external-readonly");
    expect(readStoredRow().definitionJson).toContain("protocol consumers only");

    // The post-restart reader: a fresh repo over the same database, so the
    // value comes from SQLite rather than the writer's parsed-row cache.
    const loaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );

    expect(loaded).not.toBeNull();
    expect(loaded?.charter).toEqual(makeLegacyFrozenCharter());
    expect(
      loaded?.workingDefinition.executionContexts.find(
        (context) => context.id === FROZEN_CONTEXT_ID,
      )?.charter,
    ).toEqual(makeLegacyFrozenCharter());
    expect(readStoredRow()).toEqual(before);
  });

  it("renders the loaded frozen charter with legacy sources as global and no permission-gated text", () => {
    const loaded = createGraphWorkflowExecutionsRepo(fixture.db).getActive(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    expectLegacySourcesRenderedAsGlobalPlain(
      renderCharterPromptSection(loaded.charter, RENDER_CONTEXT_ID),
    );
  });

  it("keeps stored bytes and workingDefinitionHash identical through load, render, and the next ordinary write", () => {
    const before = readStoredRow();
    // The compared tier carries the legacy fields — the comparison has teeth.
    expect(before.definitionJson).toContain("external-readonly");
    const hashBefore = workingDefinitionHash(
      buildLegacyExecution().workingDefinition,
    );

    const reader = createGraphWorkflowExecutionsRepo(fixture.db);
    const loaded = reader.getActive(PROJECT_PATH, SESSION_NAME);
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    renderCharterPromptSection(loaded.charter, RENDER_CONTEXT_ID);

    // The load perturbed nothing: the hash the amendment audit compares
    // against is the one the stored definition already had, and a read is a
    // read — byte-identical tiers, not merely deep-equal ones.
    expect(workingDefinitionHash(loaded.workingDefinition)).toBe(hashBefore);
    const afterRead = readStoredRow();
    expect(afterRead.definitionJson).toBe(before.definitionJson);
    expect(afterRead.runtimeJson).toBe(before.runtimeJson);

    // The next ordinary write persists what was loaded. A normalizing read
    // would surface here as rewritten definition bytes — this is the loop the
    // no-read-renormalization invariant exists to prevent.
    reader.setActive(
      PROJECT_PATH,
      SESSION_NAME,
      loaded,
      "2026-08-18T01:00:00.000Z",
    );
    expect(readStoredRow().definitionJson).toBe(before.definitionJson);
  });
});
