import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type BetterSqlite3 from "better-sqlite3";
import { materializeGlobalConfig } from "@/lib/config/loader";
import {
  rawGlobalConfigSchema,
  type WorkflowDefaults,
} from "@/lib/config/schemas";
import { assertDefinitionRecordSupported } from "@/lib/workflow-graph/schema-cutover-guard";
import { isResumableHalt } from "@/lib/workflow-graph/lifecycle-classifier";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { runMigrations } from "../migrator";
import { migrations } from "./index";
import {
  SchemaVersionConflictError,
  enforceSqliteSchemaCompatibility,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { createGraphWorkflowArchivedExecutionsRepo } from "../graph-workflow-archived-executions-repo";
import { PersistenceError } from "../../shared/errors";
import { createSessionsRepo } from "../sessions-repo";
import { _createTestDbAtPath } from "../state-db";
import { workflowAgentAssignments } from "./0011-workflow-agent-assignments";
import { scriptValidatorCommands } from "./0013-script-validator-commands";

type Db = InstanceType<typeof BetterSqlite3>;

const MIGRATION_NAME = "0011-workflow-agent-assignments";
const MIGRATION_SCHEMA_VERSION = 3;

const PROJECT_PATH = "/repos/legacy-workflows";
const SESSION_NAME = "legacy-session";
const GLOBAL_SCOPE_KEY = "global.shared";
const PROJECT_SCOPE_KEY = Buffer.from(PROJECT_PATH).toString("base64url");

const openDbs: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Legacy fixtures — the exact shapes that were legal pre-cutover     */
/* ------------------------------------------------------------------ */

/** config.json as an operator's disk actually held it before the cutover. */
function legacyConfigJson(): Record<string, unknown> {
  return {
    baseDir: "/repos",
    ignorePatterns: [".git"],
    agentBackends: {
      claude: { model: "opus", reasoningEffort: "high", timeoutMs: 3_600_000 },
      // No codex model/effort: the omitted-optional case the migration has to
      // materialize through the effective-value chain.
      codex: { fastMode: false, timeoutMs: null },
    },
    defaultAgentBackend: "claude",
    workflowDefaults: {
      // Pre-cutover implementer: the bare per-backend runtime triple.
      implementer: { backend: "claude", model: "opus", reasoningEffort: "max" },
      // Pre-cutover validator: the provider-named singleton, Codex variant with
      // BOTH optional fields omitted.
      contextValidator: {
        type: "codex",
        enabled: true,
        continuity: { enabled: true, contextLimitTokens: 90_000 },
        codex: {},
      },
      scriptValidator: { enabled: false },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      iterationPolicy: { maxIterations: 12, continuity: { enabled: true } },
      circuitBreaker: { consecutiveFailureThreshold: 4 },
      mutability: { allowAgentTaskAdd: true },
      planRepair: { enabled: true, maxAttemptsPerContext: 2 },
      collaboration: {
        enabled: false,
        secondAgent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        negotiationRounds: 3,
        autonomousResolutionThreshold: "minor",
      },
    },
  };
}

function legacyDefinitionRecord(
  id: string,
  name: string,
): Record<string, unknown> {
  return {
    id,
    name,
    description: null,
    schemaVersion: 1,
    revision: 3,
    definition: {
      schemaVersion: 1,
      workflowConfig: {
        // Workflow-tier legacy override pair.
        implementer: {
          backend: "codex",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
        },
        contextValidator: {
          type: "claude",
          enabled: false,
          continuity: { enabled: false },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
      },
      charter: makeTestCharter(),
      parameters: [],
      prerequisites: [],
      executionContexts: [
        {
          id: "ctx-use",
          title: "Context with a used validator",
          acceptanceCriteria: "It works.",
          // Pre-`backend` implementer: the field did not exist.
          implementer: { model: "sonnet", reasoningEffort: "low" },
          contextValidator: {
            kind: "use",
            value: {
              type: "codex",
              enabled: true,
              continuity: { enabled: true },
              codex: { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
            },
          },
        },
        {
          id: "ctx-disabled",
          title: "Context with validation disabled",
          acceptanceCriteria: "It still works.",
          contextValidator: { kind: "disabled" },
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-use",
          order: 1,
          title: "Do the thing",
          instructions: "Do it.",
          source: "user",
        },
      ],
      edges: [],
    },
    layout: {
      workflowId: id,
      contextPositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
}

/**
 * A whole execution blob in its pre-cutover shape: a real execution with every
 * context's implementer and validator rewritten back to the singleton forms.
 * The blob is archived verbatim, not reshaped, so it must be a complete
 * execution — only its two agent-config fields are legacy.
 */
function legacyExecutionBlob(
  executionId: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const execution = JSON.parse(
    JSON.stringify(createWorkflowExecution({ id: executionId })),
  ) as Record<string, unknown>;
  const workingDefinition = execution.workingDefinition as Record<
    string,
    unknown
  >;
  const contexts = (
    workingDefinition.executionContexts as Record<string, unknown>[]
  ).map((context) => ({
    ...context,
    implementer: { backend: "claude", model: "opus", reasoningEffort: "high" },
    contextValidator: {
      type: "claude",
      enabled: true,
      continuity: { enabled: true },
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    },
  }));

  return {
    ...execution,
    workingDefinition: {
      ...workingDefinition,
      executionContexts: contexts,
    },
    ...overrides,
  };
}

/** The repository's tier split, reproduced so fixtures can seed raw rows. */
const DEFINITION_KEYS = [
  "id",
  "seedDefinitionId",
  "seedDefinitionRevision",
  "boundInputs",
  "launchedTier",
  "startedAt",
  "workingDefinition",
  "charter",
];

function seedExecutionRow(
  db: Db,
  sessionName: string,
  blob: Record<string, unknown>,
): void {
  const definitionTier: Record<string, unknown> = {};
  const runtimeTier: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(blob)) {
    if (DEFINITION_KEYS.includes(key)) definitionTier[key] = value;
    else runtimeTier[key] = value;
  }
  db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    sessionName,
    blob.id as string,
    blob.seedDefinitionId as string,
    blob.seedDefinitionRevision as number,
    blob.startedAt as string,
    blob.status as string,
    (blob.completedAt as string | null) ?? null,
    JSON.stringify(definitionTier),
    JSON.stringify(runtimeTier),
    "2026-03-02T00:00:00.000Z",
  );
}

function seedSession(db: Db, sessionName: string): void {
  createSessionsRepo(db).upsert(
    PROJECT_PATH,
    sessionStateSchema.parse({
      sessionName,
      worktreePath: `/wt/${sessionName}`,
      branchName: `csm/${sessionName}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

interface LegacyWorld {
  configDir: string;
  db: Db;
}

function seedLegacyWorld(
  configJson: Record<string, unknown> = legacyConfigJson(),
): LegacyWorld {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "cc-0011-"));
  tempDirs.push(configDir);

  // The DB opens FIRST: the unrelated one-time legacy-workflow purge in
  // `openStateDb` quarantines a pre-existing `workflows/` directory on the
  // first open of a database. A real operator's disk has long since recorded
  // that marker, so seeding the scoped definitions afterwards is what
  // reproduces their actual state.
  const db = _createTestDbAtPath(path.join(configDir, "command-center.db"));
  openDbs.push(db);

  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify(configJson, null, 2),
    "utf-8",
  );
  for (const [scopeKey, workflowId] of [
    [GLOBAL_SCOPE_KEY, "wf-global"],
    [PROJECT_SCOPE_KEY, "wf-project"],
  ] as const) {
    const dir = path.join(configDir, "workflows", scopeKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${workflowId}.json`),
      JSON.stringify(legacyDefinitionRecord(workflowId, workflowId), null, 2),
      "utf-8",
    );
  }

  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);

  seedSession(db, SESSION_NAME);
  seedSession(db, "halted-session");
  seedSession(db, "terminal-session");

  seedExecutionRow(
    db,
    SESSION_NAME,
    legacyExecutionBlob("exec-running", { status: "running" }),
  );
  seedExecutionRow(
    db,
    "halted-session",
    legacyExecutionBlob("exec-halted", {
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "ctx-use",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
    }),
  );
  seedExecutionRow(
    db,
    "terminal-session",
    legacyExecutionBlob("exec-completed", {
      status: "completed",
      completedAt: "2026-03-02T00:00:00.000Z",
    }),
  );

  return { configDir, db };
}

function runCutover(world: LegacyWorld): Promise<string[]> {
  return runMigrations({ db: world.db, configDir: world.configDir }, [
    workflowAgentAssignments,
  ]);
}

/**
 * The assignment cutover and the script-validator command cutover were authored
 * on two branches and both rewrite `workflowDefaults`. Startup runs them in
 * registry order, and only the pair leaves `config.json` in a shape the loader
 * accepts: this migration carries `scriptValidator` across untouched, and `0013`
 * maps its retired `enabled` flag onto the command selection. Tests that assert
 * loadability run the pair; tests whose subject is THIS migration's own
 * behaviour still run it alone.
 */
function runConfigCutoverChain(world: LegacyWorld): Promise<string[]> {
  return runMigrations({ db: world.db, configDir: world.configDir }, [
    workflowAgentAssignments,
    scriptValidatorCommands,
  ]);
}

/**
 * `config.json` holds the RAW shape — blocks the loader materializes are absent
 * from disk — so loadability is proven through the loader that production uses,
 * not by demanding the migration write blocks it never owned.
 */
function loadMigratedWorkflowDefaults(configDir: string): WorkflowDefaults {
  const defaults = materializeGlobalConfig(
    rawGlobalConfigSchema.parse(readConfig(configDir)),
  ).workflowDefaults;
  // Every caller seeds a config that carries the block; losing it would be the
  // migration dropping operator configuration, not an optional-field case.
  if (defaults === undefined) {
    throw new Error("migrated config.json carries no workflowDefaults block");
  }
  return defaults;
}

function readConfig(configDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(configDir, "config.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function readDefinition(
  configDir: string,
  scopeKey: string,
  workflowId: string,
): unknown {
  return JSON.parse(
    readFileSync(
      path.join(configDir, "workflows", scopeKey, `${workflowId}.json`),
      "utf-8",
    ),
  );
}

function archivedRow(
  db: Db,
  sessionName: string,
  executionId: string,
): { status: string; execution_json: string } {
  const row = db
    .prepare(
      `SELECT status, execution_json FROM graph_workflow_archived_executions
        WHERE project_path = ? AND session_name = ? AND execution_id = ?`,
    )
    .get(PROJECT_PATH, sessionName, executionId);
  if (row === undefined)
    throw new Error(`archived row missing: ${executionId}`);
  return row as { status: string; execution_json: string };
}

/* ------------------------------------------------------------------ */

describe("0011-workflow-agent-assignments", () => {
  it("rewrites config.json workflowDefaults onto assignments, materializing omitted Codex optionals", async () => {
    const world = seedLegacyWorld();

    await runConfigCutoverChain(world);

    // Loadable through the LIVE loader: the cutover produced current bytes.
    expect(loadMigratedWorkflowDefaults(world.configDir)).toMatchObject({
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: { backend: "claude", model: "opus", reasoningEffort: "max" },
      },
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            strategy: "task",
            agent: {
              backend: "codex",
              // config.json declares no codex model/effort, so the effective
              // values the resolver computes are materialized.
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
            continuity: { enabled: true, contextLimitTokens: 90_000 },
          },
        ],
      },
    });
  });

  /**
   * The pre-cutover Codex profile parsed its model as `z.string().trim().min(1)`,
   * and `.trim()` there is a TRANSFORM: the padding never reached the runtime,
   * so this profile's effective model is the trimmed one. A frozen chain that
   * validates the raw string instead would call a perfectly ordinary config
   * off-catalog and block the cutover on it.
   */
  it("materializes a whitespace-padded Codex profile model as its trimmed effective value", async () => {
    const config = legacyConfigJson();
    (config.agentBackends as Record<string, unknown>).codex = {
      model: "  gpt-5.4  ",
      fastMode: false,
      timeoutMs: null,
    };
    const world = seedLegacyWorld(config);

    await expect(runConfigCutoverChain(world)).resolves.toContain(
      MIGRATION_NAME,
    );

    expect(
      loadMigratedWorkflowDefaults(world.configDir).contextValidator
        ?.assignments[0]?.agent,
    ).toEqual({
      backend: "codex",
      model: "gpt-5.4",
      // Clamped against the trimmed model, which is the one the levels table
      // and the pre-cutover transport both saw.
      reasoningEffort: "high",
    });
  });

  /**
   * `config.json`'s Codex profile accepts ANY non-empty model string so a newly
   * released model works without a code change, and that string IS the runtime
   * a legacy Codex validator with omitted fields dispatched with. A workflow
   * agent's runtime, meanwhile, is catalog-bound. When the effective value is
   * not expressible as an assignment the migration has no honest move: writing
   * it leaves configuration that no longer loads, and substituting another
   * model silently rewrites what the operator's validators run on. It refuses
   * instead — the migration transforms shape, never values.
   */
  it("refuses the cutover rather than substitute an off-catalog Codex model", async () => {
    const config = legacyConfigJson();
    (config.agentBackends as Record<string, unknown>).codex = {
      model: "gpt-5.7-preview",
      reasoningEffort: "xhigh",
      fastMode: false,
      timeoutMs: null,
    };
    const world = seedLegacyWorld(config);
    const before = readFileSync(
      path.join(world.configDir, "config.json"),
      "utf-8",
    );

    // Located and actionable: which holder, which value, what to change.
    await expect(runCutover(world)).rejects.toThrow(
      /config\.json workflowDefaults[\s\S]*gpt-5\.7-preview/,
    );

    // Fail-closed means nothing moved: the operator fixes the config and the
    // migration replays from a clean pre-cutover state.
    expect(
      readFileSync(path.join(world.configDir, "config.json"), "utf-8"),
    ).toBe(before);
    expect(
      world.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: null });
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
        .get(),
    ).toEqual({ c: 3 });
  });

  /**
   * Three states hide behind "the profile gave me no value", and only one of
   * them is absence. A value the pre-cutover config schema REJECTS never had an
   * effective runtime at all: `readConfig()` threw on that file, so the
   * descriptor default was never in force and no legacy validator ever
   * dispatched with it. Treating it as absent would invent a runtime nobody
   * ran; stamping the cutover would strand the operator with a config that
   * still does not load. The refusal is up front and unconditional — an
   * unconsumed invalid profile is exactly as unloadable as a consumed one.
   */
  const unloadableCodexProfiles: ReadonlyArray<{
    name: string;
    codex: unknown;
    expected: RegExp;
  }> = [
    {
      name: "a blank model",
      codex: { model: "", fastMode: false, timeoutMs: null },
      expected: /agentBackends\.codex\.model[\s\S]*""/,
    },
    {
      name: "an all-whitespace model",
      codex: { model: "   ", fastMode: false, timeoutMs: null },
      expected: /agentBackends\.codex\.model[\s\S]*" {3}"/,
    },
    {
      name: "a non-string model",
      codex: { model: 42, fastMode: false, timeoutMs: null },
      expected: /agentBackends\.codex\.model[\s\S]*42/,
    },
    {
      name: "a non-string effort",
      codex: { model: "gpt-5.5", reasoningEffort: 5, timeoutMs: null },
      expected: /agentBackends\.codex\.reasoningEffort[\s\S]*5/,
    },
    {
      name: "an effort outside the enum",
      codex: { model: "gpt-5.5", reasoningEffort: "turbo", timeoutMs: null },
      expected: /agentBackends\.codex\.reasoningEffort[\s\S]*turbo/,
    },
    {
      // The pre-cutover profile refined model against effort, so this pair was
      // rejected even though each field is well-formed on its own.
      name: "an effort the configured model does not support",
      codex: { model: "gpt-5.4", reasoningEffort: "ultra", timeoutMs: null },
      expected: /agentBackends\.codex\.reasoningEffort[\s\S]*ultra/,
    },
    {
      // Same refinement one tier later: the raw profile passed, but the model
      // merged in from the descriptor defaults does not support this effort, so
      // materializing the global config threw.
      name: "an effort the default model does not support",
      codex: { reasoningEffort: "ultra", timeoutMs: null },
      expected: /agentBackends\.codex\.reasoningEffort[\s\S]*ultra/,
    },
    {
      name: "a profile that is not an object",
      codex: "gpt-5.4",
      expected: /agentBackends\.codex[\s\S]*gpt-5\.4/,
    },
  ];

  it.each(unloadableCodexProfiles)(
    "refuses the cutover when config.json declares $name",
    async ({ codex, expected }) => {
      const config = legacyConfigJson();
      (config.agentBackends as Record<string, unknown>).codex = codex;
      const world = seedLegacyWorld(config);
      const before = readFileSync(
        path.join(world.configDir, "config.json"),
        "utf-8",
      );

      await expect(runCutover(world)).rejects.toThrow(expected);

      // Fail-closed means nothing moved on any surface: the operator fixes
      // config.json and the migration replays from a pre-cutover state.
      expect(
        readFileSync(path.join(world.configDir, "config.json"), "utf-8"),
      ).toBe(before);
      expect(
        readDefinition(world.configDir, GLOBAL_SCOPE_KEY, "wf-global"),
      ).toEqual(legacyDefinitionRecord("wf-global", "wf-global"));
      expect(
        world.db
          .prepare("SELECT MAX(version) AS v FROM schema_migrations")
          .get(),
      ).toEqual({ v: null });
      expect(
        world.db
          .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
          .get(),
      ).toEqual({ c: 3 });
    },
  );

  /**
   * The migration's frozen chain is only honest if it agrees with the loader it
   * was copied from. `agentBackends` is not a cutover surface, so the live
   * config chain IS the pre-cutover chain for these profiles: running each
   * fixture through it proves the refusals above are the loader's own verdicts
   * and not this migration's invention.
   */
  it.each(unloadableCodexProfiles)(
    "agrees with the config loader, which cannot load $name",
    ({ codex }) => {
      const config = legacyConfigJson();
      (config.agentBackends as Record<string, unknown>).codex = codex;
      // The legacy workflowDefaults are this migration's job and no longer
      // parse; dropping them isolates the profile as the only reason to throw.
      const backendsOnly = { ...config };
      delete backendsOnly.workflowDefaults;

      expect(() =>
        materializeGlobalConfig(rawGlobalConfigSchema.parse(backendsOnly)),
      ).toThrow();
    },
  );

  /**
   * The same parity in the other direction, and R3.1's "materialized to the
   * resolver's effective values" read literally: what the loader computes for a
   * profile the migration accepts is exactly what it writes into an assignment
   * — or, for the off-catalog model, exactly what it refuses to replace.
   */
  it.each([
    {
      name: "an omitted model and effort",
      codex: { fastMode: false, timeoutMs: null },
      effective: { model: "gpt-5.4", reasoningEffort: "high" },
    },
    {
      name: "a whitespace-padded model",
      codex: { model: "  gpt-5.4  ", fastMode: false, timeoutMs: null },
      effective: { model: "gpt-5.4", reasoningEffort: "high" },
    },
    {
      name: "an off-catalog model",
      codex: {
        model: "gpt-5.7-preview",
        reasoningEffort: "xhigh",
        fastMode: false,
        timeoutMs: null,
      },
      effective: { model: "gpt-5.7-preview", reasoningEffort: "xhigh" },
    },
  ])(
    "materializes the effective runtime the config loader computes for $name",
    ({ codex, effective }) => {
      const config = legacyConfigJson();
      (config.agentBackends as Record<string, unknown>).codex = codex;
      const backendsOnly = { ...config };
      delete backendsOnly.workflowDefaults;

      const loaded = materializeGlobalConfig(
        rawGlobalConfigSchema.parse(backendsOnly),
      );

      expect({
        model: loaded.agentBackends.codex.model,
        reasoningEffort: loaded.agentBackends.codex.reasoningEffort,
      }).toEqual(effective);
    },
  );

  /**
   * Unlike the off-catalog case below, this refusal does not wait for a holder
   * that needs the value. An unloadable profile is a config the post-cutover
   * loader rejects just as the pre-cutover one did, and stamping the schema
   * version over it would spend the one-time cutover on a config nobody can
   * load — with no replay left to fix it.
   */
  it("refuses an unloadable Codex profile no holder would have materialized", async () => {
    const config = legacyConfigJson();
    (config.agentBackends as Record<string, unknown>).codex = {
      model: "",
      fastMode: false,
      timeoutMs: null,
    };
    const defaults = config.workflowDefaults as Record<string, unknown>;
    defaults.contextValidator = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true, contextLimitTokens: 90_000 },
      codex: { model: "gpt-5.5", reasoningEffort: "low" },
    };
    const world = seedLegacyWorld(config);

    await expect(runCutover(world)).rejects.toThrow(
      /agentBackends\.codex\.model/,
    );
    expect(
      world.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: null });
  });

  /**
   * The same rule one level up. A `config.json` that is well-formed JSON but not
   * an object is not "no config" — the loader threw on it, so its Codex profile
   * was never in force either, and reading it as an absent profile would
   * materialize defaults out of a file nobody could load. Unparseable JSON
   * already propagates; this closes the parseable-but-not-an-object case beside
   * it.
   */
  it("refuses a config.json that is not a JSON object", async () => {
    const world = seedLegacyWorld();
    writeFileSync(
      path.join(world.configDir, "config.json"),
      JSON.stringify(["not", "a", "config"]),
      "utf-8",
    );

    await expect(runCutover(world)).rejects.toThrow(/config\.json/);
    expect(
      world.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: null });
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
        .get(),
    ).toEqual({ c: 3 });
  });

  /**
   * The refusal is driven by what a holder actually needs, not by the mere
   * presence of an off-catalog profile: a validator that states its own runtime
   * never consults the effective-value chain, so the cutover proceeds.
   */
  it("completes when an off-catalog Codex profile is never materialized", async () => {
    const config = legacyConfigJson();
    (config.agentBackends as Record<string, unknown>).codex = {
      model: "gpt-5.7-preview",
      reasoningEffort: "xhigh",
      fastMode: false,
      timeoutMs: null,
    };
    const defaults = config.workflowDefaults as Record<string, unknown>;
    defaults.contextValidator = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true, contextLimitTokens: 90_000 },
      codex: { model: "gpt-5.5", reasoningEffort: "low" },
    };
    const world = seedLegacyWorld(config);

    await expect(runConfigCutoverChain(world)).resolves.toContain(
      MIGRATION_NAME,
    );

    expect(
      loadMigratedWorkflowDefaults(world.configDir).contextValidator
        ?.assignments[0]?.agent,
    ).toEqual({
      backend: "codex",
      model: "gpt-5.5",
      reasoningEffort: "low",
    });
  });

  it("locates the refusal at the definition document that needs the value", async () => {
    const config = legacyConfigJson();
    (config.agentBackends as Record<string, unknown>).codex = {
      model: "gpt-5.7-preview",
      reasoningEffort: "xhigh",
      fastMode: false,
      timeoutMs: null,
    };
    const defaults = config.workflowDefaults as Record<string, unknown>;
    defaults.contextValidator = {
      type: "codex",
      enabled: true,
      continuity: { enabled: true },
      codex: { model: "gpt-5.5", reasoningEffort: "low" },
    };
    const world = seedLegacyWorld(config);

    // Only this context omits its Codex runtime, so only it needs the chain.
    const record = legacyDefinitionRecord("wf-global", "wf-global");
    const definition = record.definition as Record<string, unknown>;
    const contexts = definition.executionContexts as Record<string, unknown>[];
    contexts[0] = {
      ...contexts[0],
      contextValidator: {
        kind: "use",
        value: {
          type: "codex",
          enabled: true,
          continuity: { enabled: true },
          codex: {},
        },
      },
    };
    writeFileSync(
      path.join(
        world.configDir,
        "workflows",
        GLOBAL_SCOPE_KEY,
        "wf-global.json",
      ),
      JSON.stringify(record, null, 2),
      "utf-8",
    );

    await expect(runCutover(world)).rejects.toThrow(
      /wf-global\.json[\s\S]*ctx-use[\s\S]*gpt-5\.7-preview/,
    );
    expect(
      world.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: null });
  });

  it("preserves every unrelated config.json field", async () => {
    const world = seedLegacyWorld();
    const before = legacyConfigJson();

    await runCutover(world);

    const after = readConfig(world.configDir);
    expect(after.baseDir).toEqual(before.baseDir);
    expect(after.agentBackends).toEqual(before.agentBackends);
    expect(
      (after.workflowDefaults as Record<string, unknown>).iterationPolicy,
    ).toEqual({ maxIterations: 12, continuity: { enabled: true } });
  });

  it("migrates definition documents in BOTH scope tiers, including disabled cohorts", async () => {
    const world = seedLegacyWorld();

    await runCutover(world);

    for (const [scopeKey, workflowId] of [
      [GLOBAL_SCOPE_KEY, "wf-global"],
      [PROJECT_SCOPE_KEY, "wf-project"],
    ] as const) {
      const raw = readDefinition(world.configDir, scopeKey, workflowId);
      // The live read path accepts it — no legacy shape survives.
      const record = assertDefinitionRecordSupported(raw);

      expect(record.definition.workflowConfig.implementer).toEqual({
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: {
          backend: "codex",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
        },
      });
      // enabled:false keeps its dormant assignment (R2 losslessness).
      expect(record.definition.workflowConfig.contextValidator).toEqual({
        enabled: false,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            strategy: "conversation",
            // The pre-cutover validator blocked, so the migration writes
            // blocking rather than letting it decay to the advisory default.
            authority: "blocking",
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: false },
          },
        ],
      });

      const used = record.definition.executionContexts[0]!;
      expect(used.implementer).toEqual({
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        // A pre-`backend` implementer materializes the Claude backend it ran on.
        agent: { backend: "claude", model: "sonnet", reasoningEffort: "low" },
      });
      expect(used.contextValidator).toEqual({
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            strategy: "task",
            authority: "blocking",
            // Explicit legacy values are copied VERBATIM, never re-derived.
            agent: {
              backend: "codex",
              model: "gpt-5.6-sol",
              reasoningEffort: "ultra",
            },
            continuity: { enabled: true },
          },
        ],
      });

      // A bare context-level disable becomes an empty disabled cohort.
      const disabled = record.definition.executionContexts[1]!;
      expect(disabled.contextValidator).toEqual({
        enabled: false,
        assignments: [],
      });
    }
  });

  it("aborts a running execution with the migration-cutover reason and archives a still-decodable record", async () => {
    const world = seedLegacyWorld();

    await runCutover(world);

    const row = archivedRow(world.db, SESSION_NAME, "exec-running");
    expect(row.status).toBe("aborted");
    const blob = JSON.parse(row.execution_json) as Record<string, unknown>;
    expect(blob.haltReason).toEqual({
      type: "aborted",
      cause: "migration_cutover",
      summary: expect.stringContaining("agent assignments"),
    });

    // Read-only decode floor: the archived record still loads.
    const repo = createGraphWorkflowArchivedExecutionsRepo(world.db);
    const decoded = repo.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "exec-running",
    );
    expect(decoded?.status).toBe("aborted");
    expect(
      decoded?.workingDefinition.executionContexts[0]?.contextValidator,
    ).toMatchObject({ enabled: true, assignments: [{ id: "general" }] });

    // The row is never rewritten by the read.
    expect(archivedRow(world.db, SESSION_NAME, "exec-running")).toEqual(row);
  });

  it("aborts a halted-but-resumable execution and leaves no resume path", async () => {
    const world = seedLegacyWorld();

    await runCutover(world);

    const row = archivedRow(world.db, "halted-session", "exec-halted");
    expect(row.status).toBe("aborted");
    const blob = JSON.parse(row.execution_json) as {
      haltReason: { type: "aborted"; cause: string };
    };
    // A resumable circuit-breaker halt is replaced by the non-resumable abort.
    expect(blob.haltReason.cause).toBe("migration_cutover");
    expect(
      isResumableHalt({ type: "aborted", cause: null, summary: null }),
    ).toBe(false);
    // Nothing is left in the active slot to resume.
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
        .get(),
    ).toEqual({ c: 0 });
  });

  it("archives a cutover-terminal execution unchanged", async () => {
    const world = seedLegacyWorld();
    const expected = legacyExecutionBlob("exec-completed", {
      status: "completed",
      completedAt: "2026-03-02T00:00:00.000Z",
    });

    await runCutover(world);

    const row = archivedRow(world.db, "terminal-session", "exec-completed");
    expect(row.status).toBe("completed");
    expect(JSON.parse(row.execution_json)).toEqual(expected);
  });

  it("skips an unreadable definition document instead of blocking startup", async () => {
    const world = seedLegacyWorld();
    writeFileSync(
      path.join(world.configDir, "workflows", GLOBAL_SCOPE_KEY, "corrupt.json"),
      "{not valid json",
      "utf-8",
    );

    await expect(runCutover(world)).resolves.toContain(MIGRATION_NAME);

    // The corrupt file is left exactly as it was; its neighbours migrated.
    expect(
      readFileSync(
        path.join(
          world.configDir,
          "workflows",
          GLOBAL_SCOPE_KEY,
          "corrupt.json",
        ),
        "utf-8",
      ),
    ).toBe("{not valid json");
    expect(
      assertDefinitionRecordSupported(
        readDefinition(world.configDir, GLOBAL_SCOPE_KEY, "wf-global"),
      ).definition.workflowConfig.implementer?.profile,
    ).toEqual({ tier: "builtin", id: "general-implementer" });
  });

  it("quarantines an unreadable execution row into history and still empties the active table", async () => {
    const world = seedLegacyWorld();
    seedSession(world.db, "corrupt-session");
    world.db
      .prepare(
        `INSERT INTO graph_workflow_executions (
           project_path, session_name, execution_id, seed_definition_id,
           seed_definition_revision, started_at, status, completed_at,
           definition_json, runtime_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PROJECT_PATH,
        "corrupt-session",
        "exec-corrupt",
        "workflow-legacy",
        1,
        "2026-03-01T00:00:00.000Z",
        "running",
        null,
        "{not valid json",
        "{}",
        "2026-03-02T00:00:00.000Z",
      );

    await expect(runCutover(world)).resolves.toContain(MIGRATION_NAME);

    // Cutover requires terminal executions: NO live runtime state survives it,
    // including a row this migration could not read.
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
        .get(),
    ).toEqual({ c: 0 });

    // Its bytes are preserved as history rather than destroyed.
    const row = archivedRow(world.db, "corrupt-session", "exec-corrupt");
    expect(row.status).toBe("aborted");
    expect(JSON.parse(row.execution_json)).toEqual({
      unreadableExecution: {
        migration: MIGRATION_NAME,
        definitionJson: "{not valid json",
        runtimeJson: "{}",
      },
    });

    // It is history nobody can decode — it was already unreadable before the
    // cutover, so the list skips it and the point lookup still fails loudly.
    const repo = createGraphWorkflowArchivedExecutionsRepo(world.db);
    expect(repo.listBySession(PROJECT_PATH, "corrupt-session")).toEqual([]);
    expect(() =>
      repo.findByExecution(PROJECT_PATH, "corrupt-session", "exec-corrupt"),
    ).toThrow(PersistenceError);
  });

  it("empties the active table even when history already holds that execution", async () => {
    const world = seedLegacyWorld();
    // One id in both tables is not a state the archive path can produce, but a
    // stamped cutover that left the live row behind would never retry.
    world.db
      .prepare(
        `INSERT INTO graph_workflow_archived_executions (
           project_path, session_name, execution_id, archived_at,
           status, started_at, completed_at, execution_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PROJECT_PATH,
        SESSION_NAME,
        "exec-running",
        "2026-02-01T00:00:00.000Z",
        "completed",
        "2026-01-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z",
        '{"pre":"existing"}',
      );

    await expect(runCutover(world)).resolves.toContain(MIGRATION_NAME);

    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
        .get(),
    ).toEqual({ c: 0 });
    // An archived record is never rewritten, not even by the cutover.
    expect(
      archivedRow(world.db, SESSION_NAME, "exec-running").execution_json,
    ).toBe('{"pre":"existing"}');
  });

  it("is a no-op on re-run", async () => {
    const world = seedLegacyWorld();

    await runCutover(world);
    const firstConfig = readFileSync(
      path.join(world.configDir, "config.json"),
      "utf-8",
    );
    const firstArchived = world.db
      .prepare(
        "SELECT execution_json FROM graph_workflow_archived_executions ORDER BY execution_id",
      )
      .all();

    await workflowAgentAssignments.up({
      name: MIGRATION_NAME,
      context: { db: world.db, configDir: world.configDir },
    });

    expect(
      readFileSync(path.join(world.configDir, "config.json"), "utf-8"),
    ).toBe(firstConfig);
    expect(
      world.db
        .prepare(
          "SELECT execution_json FROM graph_workflow_archived_executions ORDER BY execution_id",
        )
        .all(),
    ).toEqual(firstArchived);
  });

  it("recovers from a crash mid-migration without double-applying", async () => {
    const world = seedLegacyWorld();
    world.db.exec(`
      CREATE TEMP TRIGGER fail_archive
      BEFORE INSERT ON graph_workflow_archived_executions
      WHEN NEW.execution_id = 'exec-completed'
      BEGIN
        SELECT RAISE(ABORT, 'simulated mid-migration failure');
      END;
    `);

    await expect(runCutover(world)).rejects.toThrow(
      /simulated mid-migration failure/,
    );

    // The DB phase is one transaction: nothing archived, nothing emptied.
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_archived_executions")
        .get(),
    ).toEqual({ c: 0 });
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_executions")
        .get(),
    ).toEqual({ c: 3 });
    expect(
      world.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: null });

    world.db.exec("DROP TRIGGER temp.fail_archive");
    await runCutover(world);

    // The already-rewritten config file did not migrate twice.
    const defaults = (
      readConfig(world.configDir) as {
        workflowDefaults: { contextValidator: { assignments: unknown[] } };
      }
    ).workflowDefaults;
    expect(defaults.contextValidator.assignments).toHaveLength(1);
    expect(
      world.db
        .prepare("SELECT COUNT(*) AS c FROM graph_workflow_archived_executions")
        .get(),
    ).toEqual({ c: 3 });
    expect(
      world.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: MIGRATION_SCHEMA_VERSION });
  });

  /**
   * A migration is a record of what was done to an operator's disk on one
   * particular day. Reaching for a live schema, resolver, or seed would let a
   * later edit retroactively change that — the 0008/0009 lesson. Every mapping
   * rule, catalog, and default here is a frozen literal, so the only imports
   * this file may take are the runner's own plumbing.
   */
  it("freezes its mapping rules: no live schema, resolver, or seed imports", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./0011-workflow-agent-assignments.ts", import.meta.url),
      "utf8",
    );

    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1])
      .sort();
    expect(specifiers).toEqual([
      "../schema-compatibility",
      "../state-db",
      "./types",
      "@/lib/logging",
      "@/lib/shared/atomic-write-json",
      "@/lib/shared/errors",
      "node:fs/promises",
      "node:path",
      "zod",
    ]);
  });

  it("is registered in the runner and stamps a fresh database with floor behavior", async () => {
    expect(migrations.map((migration) => migration.name)).toContain(
      MIGRATION_NAME,
    );

    const dir = mkdtempSync(path.join(os.tmpdir(), "cc-0011-fresh-"));
    tempDirs.push(dir);
    const db = _createTestDbAtPath(path.join(dir, "command-center.db"));
    openDbs.push(db);

    const applied = await runMigrations({ db, configDir: dir }, [
      workflowAgentAssignments,
    ]);

    expect(applied).toEqual([MIGRATION_NAME]);
    expect(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: MIGRATION_SCHEMA_VERSION });
    expect(
      existsSync(schemaCompatibilityBarrierPath(dir, MIGRATION_SCHEMA_VERSION)),
    ).toBe(true);
    expect(() => enforceSqliteSchemaCompatibility(db, "test-db", 2)).toThrow(
      SchemaVersionConflictError,
    );
  });
});
