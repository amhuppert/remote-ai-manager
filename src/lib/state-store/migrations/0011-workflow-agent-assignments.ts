import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { atomicWriteJson } from "@/lib/shared/atomic-write-json";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");

const MIGRATION_NAME = "0011-workflow-agent-assignments";
const MIGRATION_SCHEMA_VERSION = 3;
const MIGRATION_SCHEMA_DESCRIPTION =
  "Workflow agents are library assignments; validators are cohorts";

/**
 * BREAKING migration — the agent-assignment / validator-cohort hard cutover.
 *
 * The bare implementer runtime triple and the provider-named singleton
 * validator (`{type: 'claude' | 'codex'}`) are replaced by assignments onto
 * library profiles and by ordered validator cohorts. The charter forbids an
 * inbound compatibility parser, so every persisted holder of a legacy shape is
 * rewritten exactly once, here, behind the forward-only version barrier:
 *
 * 1. `config.json` `workflowDefaults` — read raw and rewritten atomically.
 * 2. Every scoped definition document under `<configDir>/workflows/<scopeKey>/`
 *    in BOTH tiers (the reserved `global.shared` key and every project key).
 * 3. Every `graph_workflow_executions` row — merged, stamped, archived, and the
 *    active table emptied. Emptying it is what makes "no inbound compatibility
 *    parser" literally true: after this runs, no live code path can be handed a
 *    legacy execution blob.
 *
 * Cutover requires cutover-terminal executions. An execution is terminal only
 * when it has finished with no remaining resume path; everything else — running,
 * paused, pending, and halted-but-resumable alike — is aborted here with a
 * distinct `migration_cutover` reason, ending its resume path. No live runtime
 * state (working definitions, lane keys, continuity, pending questions) is
 * carried forward: the archived blob is history, not a resumable run.
 *
 * Archived blobs are never rewritten — including the ones this migration writes.
 * They keep their pre-cutover shapes and are read through the approved
 * read-only decode floor in the archived-executions repository, the single
 * recorded backward-compatibility exception.
 *
 * Frozen by design (the 0008/0009 lesson): every schema, mapping rule, status
 * taxonomy, tier-key list, and effective-value default below is a literal copy
 * taken at cutover time and binds NO live module. A later change to the live
 * schemas, seeds, or model catalog must not retroactively change what this
 * migration did to an operator's disk.
 */

/* ------------------------------------------------------------------ */
/*  Frozen identity                                                    */
/* ------------------------------------------------------------------ */

const IMPLEMENTER_ASSIGNMENT_ID = "implementer";
const IMPLEMENTER_PROFILE = {
  tier: "builtin",
  id: "general-implementer",
} as const;
const VALIDATOR_ASSIGNMENT_ID = "general";
const VALIDATOR_PROFILE = { tier: "builtin", id: "general-reviewer" } as const;

const CUTOVER_ABORT_SUMMARY =
  "Aborted by the agent assignments cutover: this run's configuration used the " +
  "pre-cutover implementer and validator shapes, which no longer load. Relaunch " +
  "the workflow to continue.";

/* ------------------------------------------------------------------ */
/*  Frozen pre-cutover schemas                                         */
/* ------------------------------------------------------------------ */

const frozenClaudeModelSchema = z.enum(["fable", "opus", "sonnet", "haiku"]);
const frozenEffortLevelSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
  "ultra",
]);
const frozenCodexModelSchema = z.enum([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
]);
const frozenCodexEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/**
 * The legacy agent config. The `backend`-defaulting preprocess is reproduced
 * because documents written before the field existed are still on disk; the
 * default it applies (Claude) is the backend those runs actually used.
 */
const frozenAgentConfigSchema = z.preprocess(
  (val) => {
    if (typeof val === "object" && val !== null && !("backend" in val)) {
      return { ...val, backend: "claude" };
    }
    return val;
  },
  z.discriminatedUnion("backend", [
    z.object({
      backend: z.literal("claude"),
      model: frozenClaudeModelSchema,
      reasoningEffort: frozenEffortLevelSchema,
    }),
    z.object({
      backend: z.literal("codex"),
      model: frozenCodexModelSchema,
      reasoningEffort: frozenCodexEffortSchema,
    }),
  ]),
);

const frozenValidatorBaseSchema = z.object({
  enabled: z.boolean().default(true),
});

const frozenSingletonValidatorSchema = z.discriminatedUnion("type", [
  frozenValidatorBaseSchema.extend({
    type: z.literal("claude"),
    agent: frozenAgentConfigSchema,
  }),
  frozenValidatorBaseSchema.extend({
    type: z.literal("codex"),
    codex: z
      .object({
        model: frozenCodexModelSchema.optional(),
        reasoningEffort: frozenCodexEffortSchema.optional(),
      })
      .default({}),
  }),
]);

/** The context-tier wrapper: `use` carried the singleton, `disabled` was bare. */
const frozenContextValidatorOverrideSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("use"), value: frozenSingletonValidatorSchema }),
  z.object({ kind: z.literal("disabled") }),
]);

/* ------------------------------------------------------------------ */
/*  Frozen effective-value chain                                       */
/* ------------------------------------------------------------------ */

/**
 * Codex reasoning levels per model, frozen at cutover. It serves the config
 * profile only: clamping the default effort, and reproducing the refinement
 * that decided whether that profile loaded at all. A validator's own persisted
 * effort is copied verbatim even if this table would not have offered it,
 * because the migration transforms shape, not values.
 */
const FROZEN_CODEX_LEVELS: Record<string, readonly string[]> = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
};
const FROZEN_DEFAULT_CODEX_MODEL = "gpt-5.4";

const FROZEN_CODEX_PROFILE_PATH = "agentBackends.codex";

/**
 * The effective model a legacy Codex validator with no model dispatched with,
 * and whether an assignment can carry it. Those differ because `config.json`'s
 * Codex profile accepts ANY non-empty model string — a newly released model
 * needs no code change — while a workflow agent's runtime is catalog-bound.
 * The effort has no such gap: its config enum and the assignment enum are the
 * same list, so a loadable effort is always assignable.
 */
type EffectiveModel =
  | { assignable: true; value: string }
  | { assignable: false; configured: string };

interface CodexRuntimeDefaults {
  model: EffectiveModel;
  reasoningEffort: string;
}

/**
 * The Codex profile as the pre-cutover config chain read it. `loadable: false`
 * is not "no value here" — it means `config.json` did not parse, so there was
 * never an effective runtime to materialize.
 */
type CodexProfileResolution =
  | { loadable: true; defaults: CodexRuntimeDefaults }
  | { loadable: false; field: string; value: unknown; expected: string };

/** Shows the operator the offending value as it sits in their file. */
function formatRawValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Refuses the cutover because `config.json` never loaded.
 *
 * A present value the pre-cutover schema rejects is categorically unlike an
 * absent one: `readConfig()` threw on that file rather than putting the
 * descriptor default in force, so nothing ever ran with a value this migration
 * could copy. Materializing the default here would invent a runtime the
 * operator never chose, and stamping the cutover would spend the one-time
 * migration on a config that post-cutover loading still rejects — with no
 * replay left to fix it. So the refusal is up front and unconditional, before
 * any holder is consulted and before any byte is written.
 */
class CutoverConfigNotLoadableError extends Error {
  constructor(field: string, value: unknown, expected: string) {
    super(
      `${MIGRATION_NAME} cannot run: config.json does not load — ${field} is ` +
        `${formatRawValue(value)}, which the pre-cutover config schema rejects. ` +
        `That file never loaded, so there is no effective Codex runtime for the ` +
        `cutover to materialize into assignments. Expected ${expected}. Fix ` +
        `config.json and restart; the migration replays from a pre-cutover ` +
        `state, having changed nothing.`,
    );
    this.name = "CutoverConfigNotLoadableError";
  }
}

/**
 * Refuses the cutover instead of writing a runtime nobody chose.
 *
 * There is no honest third option when a LOADABLE effective value will not fit
 * an assignment: writing it leaves configuration that no longer loads, and
 * substituting another model silently changes what the operator's validators
 * run on — semantic authority a shape transform does not have. So the migration
 * stops, names the holder and the value, and says what to change. Nothing is
 * ledgered, so fixing `config.json` and restarting replays the whole cutover.
 */
class CutoverModelNotAssignableError extends Error {
  constructor(useSite: string, configured: string, allowed: readonly string[]) {
    super(
      `${MIGRATION_NAME} cannot migrate ${useSite}: its Codex validator omits ` +
        `"model", so the cutover has to materialize the effective runtime from ` +
        `${FROZEN_CODEX_PROFILE_PATH} in config.json — and the configured model ` +
        `"${configured}" is not one a workflow agent assignment can carry ` +
        `(${allowed.join(", ")}). Set that validator's codex.model explicitly, ` +
        `or change ${FROZEN_CODEX_PROFILE_PATH}.model, then restart; the ` +
        `migration replays from a pre-cutover state. It will not substitute a ` +
        `value for you.`,
    );
    this.name = "CutoverModelNotAssignableError";
  }
}

/**
 * What a legacy Codex validator with no model/effort actually dispatched with:
 * the `agentBackends.codex` profile from `config.json`, falling back to the
 * descriptor default and the model-aware effort clamp — the same chain the
 * config loader ran at read time, reproduced as frozen code, including the
 * refinements that made a profile unloadable.
 *
 * The two failure modes stay distinct on purpose. Unloadable (here) is a fact
 * about the operator's file and refuses the whole cutover; unassignable (at
 * `requireAssignableModel`) is a fact about one holder that omitted its runtime,
 * so an off-catalog profile whose validators all state their own model never
 * blocks anything.
 *
 * Scope is deliberate and stops at this profile: it is the only part of
 * `config.json` this migration reads a VALUE from. Re-freezing the rest of the
 * config schema would give a shape transform veto power over fields it neither
 * reads nor rewrites — and the loader still refuses those on its own.
 */
function resolveCodexProfile(rawConfig: unknown): CodexProfileResolution {
  const root = isRecord(rawConfig) ? rawConfig : {};

  // `z.object().optional()` admits an absent key and nothing else — a present
  // `null` or scalar failed the raw parse at each of these two levels.
  const backends = root.agentBackends;
  if (backends !== undefined && !isRecord(backends)) {
    return {
      loadable: false,
      field: "agentBackends",
      value: backends,
      expected: "an object",
    };
  }
  const codex = isRecord(backends) ? backends.codex : undefined;
  if (codex !== undefined && !isRecord(codex)) {
    return {
      loadable: false,
      field: FROZEN_CODEX_PROFILE_PATH,
      value: codex,
      expected: "an object",
    };
  }
  const configured = isRecord(codex) ? codex : {};

  // The profile parsed its model as `z.string().trim().min(1)`, where `.trim()`
  // is a TRANSFORM: the trimmed string is what the transport dispatched with,
  // so it — not the raw one — is the effective value. A blank, all-whitespace,
  // or non-string model failed that parse outright.
  const rawModel = configured.model;
  let configuredModel = FROZEN_DEFAULT_CODEX_MODEL;
  if (rawModel !== undefined) {
    if (typeof rawModel !== "string" || rawModel.trim() === "") {
      return {
        loadable: false,
        field: `${FROZEN_CODEX_PROFILE_PATH}.model`,
        value: rawModel,
        expected: "a non-empty string",
      };
    }
    configuredModel = rawModel.trim();
  }

  const model: EffectiveModel = frozenCodexModelSchema.safeParse(
    configuredModel,
  ).success
    ? { assignable: true, value: configuredModel }
    : { assignable: false, configured: configuredModel };

  const rawEffort = configured.reasoningEffort;
  if (rawEffort === undefined) {
    // The clamp runs against the CONFIGURED model, assignable or not: that is
    // the model the pre-cutover transport dispatched with, and an unknown model
    // offered every level.
    const supported = FROZEN_CODEX_LEVELS[configuredModel];
    const value =
      supported === undefined || supported.includes("high")
        ? "high"
        : (supported.at(-1) ?? "high");
    return { loadable: true, defaults: { model, reasoningEffort: value } };
  }

  const effort = frozenCodexEffortSchema.safeParse(rawEffort);
  if (!effort.success) {
    return {
      loadable: false,
      field: `${FROZEN_CODEX_PROFILE_PATH}.reasoningEffort`,
      value: rawEffort,
      expected: `one of ${frozenCodexEffortSchema.options.join(", ")}`,
    };
  }
  // The profile refined effort against model, and the materialized config
  // refined it again against the model merged in from the descriptor defaults —
  // so a present effort the EFFECTIVE model does not support failed to load
  // whether or not the model itself was written down. An unknown model has no
  // level table and supported everything.
  const supported = FROZEN_CODEX_LEVELS[configuredModel];
  if (supported !== undefined && !supported.includes(effort.data)) {
    return {
      loadable: false,
      field: `${FROZEN_CODEX_PROFILE_PATH}.reasoningEffort`,
      value: rawEffort,
      expected: `one of ${supported.join(", ")} for model "${configuredModel}"`,
    };
  }
  return { loadable: true, defaults: { model, reasoningEffort: effort.data } };
}

function requireAssignableModel(
  effective: EffectiveModel,
  useSite: string,
): string {
  if (effective.assignable) return effective.value;
  throw new CutoverModelNotAssignableError(
    useSite,
    effective.configured,
    frozenCodexModelSchema.options,
  );
}

/* ------------------------------------------------------------------ */
/*  Frozen mapping rules                                               */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `undefined` means "not a legacy shape" at every mapper below — an already
 * migrated document, or something this migration has no authority over. It is
 * the idempotence predicate: an assignment carries no top-level `model`, so it
 * can never re-match, and a cohort carries no `type`/`kind`.
 */
function migrateImplementer(
  value: unknown,
): Record<string, unknown> | undefined {
  const legacy = frozenAgentConfigSchema.safeParse(value);
  if (!legacy.success) return undefined;
  return {
    id: IMPLEMENTER_ASSIGNMENT_ID,
    profile: IMPLEMENTER_PROFILE,
    agent: legacy.data,
  };
}

function migrateSingletonValidator(
  value: unknown,
  codexDefaults: CodexRuntimeDefaults,
  useSite: string,
): Record<string, unknown> | undefined {
  const legacy = frozenSingletonValidatorSchema.safeParse(value);
  if (!legacy.success) return undefined;

  const assignment =
    legacy.data.type === "codex"
      ? {
          agent: {
            backend: "codex",
            // Explicit values verbatim; only the absent ones materialize, and
            // materializing is the only thing that can refuse.
            model:
              legacy.data.codex.model ??
              requireAssignableModel(codexDefaults.model, useSite),
            reasoningEffort:
              legacy.data.codex.reasoningEffort ??
              codexDefaults.reasoningEffort,
          },
        }
      : { agent: legacy.data.agent };

  return {
    enabled: legacy.data.enabled,
    assignments: [
      {
        id: VALIDATOR_ASSIGNMENT_ID,
        profile: VALIDATOR_PROFILE,
        ...assignment,
        // The legacy singleton WAS the acceptance-criteria verifier and it
        // blocked. Written explicitly, exactly as the seed writes it, because
        // the schema default is advisory: without this a migrated workflow
        // would silently stop being able to fail a context.
        authority: "blocking",
      },
    ],
  };
}

/** The context tier's `{kind}` wrapper; a bare disable keeps no assignment. */
function migrateContextValidatorOverride(
  value: unknown,
  codexDefaults: CodexRuntimeDefaults,
  useSite: string,
): Record<string, unknown> | undefined {
  const legacy = frozenContextValidatorOverrideSchema.safeParse(value);
  if (!legacy.success) return undefined;
  if (legacy.data.kind === "disabled") {
    return { enabled: false, assignments: [] };
  }
  return migrateSingletonValidator(legacy.data.value, codexDefaults, useSite);
}

type ValidatorMigrator = (
  value: unknown,
  codexDefaults: CodexRuntimeDefaults,
  useSite: string,
) => Record<string, unknown> | undefined;

/**
 * Rewrite one config holder in place, returning a new object when anything
 * changed and `null` when nothing did. Absent fields stay absent — the cascade
 * treats "unset" as "inherit", and inventing a tier here would silently pin a
 * value the operator never chose.
 */
function migrateHolder(
  holder: Record<string, unknown>,
  migrateValidator: ValidatorMigrator,
  codexDefaults: CodexRuntimeDefaults,
  useSite: string,
): Record<string, unknown> | null {
  let changed = false;
  const next = { ...holder };

  if ("implementer" in holder) {
    const migrated = migrateImplementer(holder.implementer);
    if (migrated !== undefined) {
      next.implementer = migrated;
      changed = true;
    }
  }
  if ("contextValidator" in holder) {
    const migrated = migrateValidator(
      holder.contextValidator,
      codexDefaults,
      useSite,
    );
    if (migrated !== undefined) {
      next.contextValidator = migrated;
      changed = true;
    }
  }

  return changed ? next : null;
}

/* ------------------------------------------------------------------ */
/*  Surface 1: config.json workflowDefaults                            */
/* ------------------------------------------------------------------ */

/**
 * Read `config.json` as raw JSON. NOT through `readRawConfig`, which degrades
 * an unparseable or schema-invalid file to `{}` — and a legacy file IS
 * schema-invalid against the post-cutover schema, so that path would silently
 * report "no config" and drop the operator's whole file on the rewrite.
 *
 * `null` means the file is absent, which is the one honest "no config" state:
 * the descriptor defaults really were in force. A present file that is not a
 * JSON object never loaded, so it refuses here for the same reason a rejected
 * profile value does — malformed JSON already propagates from `JSON.parse`.
 */
async function readRawConfigFile(
  configPath: string,
): Promise<Record<string, unknown> | null> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf-8");
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) {
    throw new CutoverConfigNotLoadableError(
      "its top-level value",
      parsed,
      "an object",
    );
  }
  return parsed;
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

async function migrateConfigFile(
  configDir: string,
): Promise<{ codexDefaults: CodexRuntimeDefaults; changed: boolean }> {
  const configPath = path.join(configDir, "config.json");
  const raw = await readRawConfigFile(configPath);
  const profile = resolveCodexProfile(raw);
  if (!profile.loadable) {
    throw new CutoverConfigNotLoadableError(
      profile.field,
      profile.value,
      profile.expected,
    );
  }
  const codexDefaults = profile.defaults;
  if (raw === null || !isRecord(raw.workflowDefaults)) {
    return { codexDefaults, changed: false };
  }

  const migrated = migrateHolder(
    raw.workflowDefaults,
    migrateSingletonValidator,
    codexDefaults,
    "config.json workflowDefaults",
  );
  if (migrated === null) return { codexDefaults, changed: false };

  // The loader's own writes are non-atomic; a migration rewriting the whole
  // file must not be able to leave a truncated config behind.
  await atomicWriteJson(configPath, { ...raw, workflowDefaults: migrated });
  return { codexDefaults, changed: true };
}

/* ------------------------------------------------------------------ */
/*  Surface 2: scoped workflow definition documents                    */
/* ------------------------------------------------------------------ */

function migrateDefinition(
  definition: Record<string, unknown>,
  codexDefaults: CodexRuntimeDefaults,
  documentPath: string,
): Record<string, unknown> | null {
  let changed = false;
  const next = { ...definition };

  if (isRecord(definition.workflowConfig)) {
    const migrated = migrateHolder(
      definition.workflowConfig,
      migrateSingletonValidator,
      codexDefaults,
      `${documentPath} workflowConfig`,
    );
    if (migrated !== null) {
      next.workflowConfig = migrated;
      changed = true;
    }
  }

  if (Array.isArray(definition.executionContexts)) {
    let contextsChanged = false;
    const contexts = definition.executionContexts.map((context, index) => {
      if (!isRecord(context)) return context;
      const contextId =
        typeof context.id === "string" ? context.id : `#${String(index)}`;
      const migrated = migrateHolder(
        context,
        migrateContextValidatorOverride,
        codexDefaults,
        `${documentPath} executionContexts.${contextId}`,
      );
      if (migrated === null) return context;
      contextsChanged = true;
      return migrated;
    });
    if (contextsChanged) {
      next.executionContexts = contexts;
      changed = true;
    }
  }

  return changed ? next : null;
}

async function migrateDefinitionDocuments(
  configDir: string,
  codexDefaults: CodexRuntimeDefaults,
): Promise<number> {
  const workflowsDir = path.join(configDir, "workflows");
  let scopeKeys: string[];
  try {
    scopeKeys = await readdir(workflowsDir);
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return 0;
    throw err;
  }

  let migratedCount = 0;
  for (const scopeKey of scopeKeys) {
    const scopeDir = path.join(workflowsDir, scopeKey);
    let entries: string[];
    try {
      entries = await readdir(scopeDir);
    } catch (err) {
      if (isNodeErrorCode(err, "ENOTDIR") || isNodeErrorCode(err, "ENOENT")) {
        continue;
      }
      throw err;
    }

    for (const entry of entries) {
      // A crash-interrupted atomic write leaves a `.json.tmp.<pid>.<uuid>`
      // sibling, which this filter excludes — the canonical file is untouched
      // until the rename, so a replay simply migrates it again.
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(scopeDir, entry);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(filePath, "utf-8"));
      } catch (err) {
        // One corrupt document must not block server startup for every other
        // workflow. It was already unreadable before this migration ran.
        logger.error("state-store.migration_document_skipped", {
          migration: MIGRATION_NAME,
          scopeKey,
          entry,
          error: getErrorMessage(err),
        });
        continue;
      }
      if (!isRecord(raw) || !isRecord(raw.definition)) continue;

      const migrated = migrateDefinition(
        raw.definition,
        codexDefaults,
        path.join("workflows", scopeKey, entry),
      );
      if (migrated === null) continue;

      await atomicWriteJson(filePath, { ...raw, definition: migrated });
      migratedCount += 1;
    }
  }
  return migratedCount;
}

/* ------------------------------------------------------------------ */
/*  Surface 3: execution rows                                          */
/* ------------------------------------------------------------------ */

/**
 * Halt reason types with no resume path, frozen from `HALT_RESUMABILITY`. Every
 * other halt reason — and an absent one — is resumable, so its execution is NOT
 * cutover-terminal.
 */
const FROZEN_NON_RESUMABLE_HALTS = new Set(["aborted", "recovery_error"]);

/**
 * Cutover-terminality over the frozen status taxonomy
 * (`pending | running | paused | completed | halted | aborted`; the codebase has
 * no `failed` execution status). Terminal = finished with no remaining resume
 * path. Unknown statuses are treated as NON-terminal: aborting a run that was
 * already over is harmless, while carrying a live run forward is not.
 */
function isCutoverTerminal(status: unknown, haltReason: unknown): boolean {
  if (status === "completed" || status === "aborted") return true;
  if (status !== "halted") return false;
  const type = isRecord(haltReason) ? haltReason.type : undefined;
  return typeof type === "string" && FROZEN_NON_RESUMABLE_HALTS.has(type);
}

interface ActiveExecutionRow {
  project_path: string;
  session_name: string;
  execution_id: string;
  started_at: string;
  definition_json: string;
  runtime_json: string;
}

/**
 * The archived form of a row whose persisted tiers will not parse. Cutover
 * requires terminal executions and carries no live runtime state forward, so
 * such a row cannot stay in the active table — but it is also the only copy of
 * the operator's bytes, so it moves to history verbatim instead of being
 * dropped. Nothing decodes it: it was already unreadable before the cutover,
 * the archived read path skips it with a diagnostic, and a point lookup still
 * fails loudly.
 */
function quarantineBlob(row: ActiveExecutionRow): string {
  return JSON.stringify({
    unreadableExecution: {
      migration: MIGRATION_NAME,
      definitionJson: row.definition_json,
      runtimeJson: row.runtime_json,
    },
  });
}

interface ArchivedRecord {
  status: string;
  startedAt: string;
  completedAt: string | null;
  executionJson: string;
  aborted: boolean;
  readable: boolean;
}

/** One active row's archived form, whether or not its tiers parse. */
function toArchivedRecord(
  row: ActiveExecutionRow,
  migratedAt: string,
): ArchivedRecord {
  let definition: unknown;
  let runtime: unknown;
  try {
    definition = JSON.parse(row.definition_json);
    runtime = JSON.parse(row.runtime_json);
  } catch {
    definition = undefined;
    runtime = undefined;
  }

  if (!isRecord(definition) || !isRecord(runtime)) {
    return {
      status: "aborted",
      startedAt: row.started_at,
      completedAt: migratedAt,
      executionJson: quarantineBlob(row),
      aborted: true,
      readable: false,
    };
  }

  // The repository's shallow tier merge, frozen: every top-level key belongs to
  // exactly one tier, so spreading them reconstructs the whole execution
  // losslessly. No field is invented and no snapshot provenance is attached —
  // the merged object is exactly what the two tiers held.
  const merged: Record<string, unknown> = { ...definition, ...runtime };

  const terminal = isCutoverTerminal(merged.status, merged.haltReason);
  if (!terminal) {
    merged.status = "aborted";
    merged.haltReason = {
      type: "aborted",
      cause: "migration_cutover",
      summary: CUTOVER_ABORT_SUMMARY,
    };
    merged.completedAt = merged.completedAt ?? migratedAt;
  }

  return {
    status: typeof merged.status === "string" ? merged.status : "aborted",
    startedAt:
      typeof merged.startedAt === "string" ? merged.startedAt : row.started_at,
    completedAt:
      typeof merged.completedAt === "string" ? merged.completedAt : null,
    executionJson: JSON.stringify(merged),
    aborted: !terminal,
    readable: true,
  };
}

/* ------------------------------------------------------------------ */

export const workflowAgentAssignments: StateMigration = {
  name: MIGRATION_NAME,
  up: async ({ context }) => {
    const { db, configDir } = context;

    // Fail-closed external barrier before any post-cutover bytes exist. A
    // rolled-back transaction intentionally leaves it published: excluding an
    // older reader is the safe direction while this build retries.
    if (configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }

    // File surfaces first, each write individually atomic, each mapper
    // idempotent — so a crash between any two of them (or between them and the
    // DB transaction) replays cleanly instead of double-applying.
    let configChanged = false;
    let definitionCount = 0;
    if (configDir !== null) {
      const configResult = await migrateConfigFile(configDir);
      configChanged = configResult.changed;
      definitionCount = await migrateDefinitionDocuments(
        configDir,
        configResult.codexDefaults,
      );
    }

    const migratedAt = new Date().toISOString();
    let archivedCount = 0;
    let abortedCount = 0;
    let quarantinedCount = 0;

    const migrate = db.transaction(() => {
      // Recheck under the write lock, witnessing this build's known version
      // (the 0006/0009 precedent) so a same-build replay converges while a
      // newer build's advance refuses.
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);

      const rows = db
        .prepare(
          `SELECT project_path, session_name, execution_id, started_at,
                  definition_json, runtime_json
             FROM graph_workflow_executions
            ORDER BY project_path ASC, session_name ASC`,
        )
        .all() as ActiveExecutionRow[];

      const insertArchived = db.prepare(
        `INSERT INTO graph_workflow_archived_executions (
           project_path, session_name, execution_id, archived_at,
           status, started_at, completed_at, execution_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_path, session_name, execution_id) DO NOTHING`,
      );

      const deleteActive = db.prepare(
        `DELETE FROM graph_workflow_executions
          WHERE project_path = ? AND session_name = ?`,
      );

      for (const row of rows) {
        const record = toArchivedRecord(row, migratedAt);
        if (!record.readable) {
          logger.error("state-store.migration_row_quarantined", {
            migration: MIGRATION_NAME,
            table: "graph_workflow_executions",
            executionId: row.execution_id,
          });
          quarantinedCount += 1;
        }
        if (record.aborted) abortedCount += 1;

        const result = insertArchived.run(
          row.project_path,
          row.session_name,
          row.execution_id,
          migratedAt,
          record.status,
          record.startedAt,
          record.completedAt,
          record.executionJson,
        );
        if (result.changes === 1) {
          archivedCount += 1;
        } else {
          // Archiving normally deletes the active row in the same transaction,
          // so one execution id in both tables is not a state that path can
          // produce. History is never rewritten, so the existing archived
          // record stands as this execution's record.
          logger.warn("state-store.migration_archive_conflict", {
            migration: MIGRATION_NAME,
            executionId: row.execution_id,
          });
        }

        // Unconditional, and the reason the loop archives even an unreadable
        // row first: cutover requires terminal executions and carries no live
        // runtime state forward, but this migration ledgers itself in the same
        // transaction and never retries. A row left behind here would survive
        // the cutover permanently.
        deleteActive.run(row.project_path, row.session_name);
      }

      const stamped = db
        .prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, description)
           VALUES (?, ?)`,
        )
        .run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);

      logger.info("state-store.migration_workflow_assignments_cutover", {
        migration: MIGRATION_NAME,
        configChanged,
        definitionCount,
        archivedCount,
        abortedCount,
        quarantinedCount,
        versionStamped: stamped.changes === 1,
      });
    });

    try {
      migrate.immediate();
    } catch (err) {
      logger.error("state-store.migration_failed", {
        migration: MIGRATION_NAME,
        error: getErrorMessage(err),
      });
      throw err;
    }
  },
};
