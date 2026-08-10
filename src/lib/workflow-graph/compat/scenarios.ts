import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  migrateRawDefinitionPlacement,
  migrateRawExecutionPlacement,
} from "@/lib/workflow-graph/placement-migration";
import type { CompatibilityScenario } from "./engine-harness";
import {
  compatibilityRecordingSchema,
  type CompatibilityRecording,
} from "./projections";

/**
 * The committed pre-D4 corpus: fixture definitions under `fixtures/`, the
 * projections they produced under `recordings/`, and the deterministic agent
 * script each scenario runs.
 *
 * The fixtures and recordings were authored and captured against the pre-D4
 * engine. Neither is regenerated as a matter of course — a recording changes
 * only through an explicit {@link RECORDING_UPDATE_ENV} run, and changing one is
 * a claim that observable pre-D4 behaviour genuinely moved.
 *
 * Test-support only; not imported by production code.
 */

export const COMPATIBILITY_SCENARIOS = [
  "linear-chain",
  "parallel-fan-in",
  "iteration-halt",
  "validator-reopen",
] as const;
export type CompatibilityScenarioName =
  (typeof COMPATIBILITY_SCENARIOS)[number];

export const RECORDING_UPDATE_ENV = "CC_UPDATE_COMPAT_RECORDINGS";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function fixturePath(fileName: string): string {
  return path.join(moduleDir, "fixtures", fileName);
}

function recordingPath(scenarioName: string): string {
  return path.join(moduleDir, "recordings", `${scenarioName}.json`);
}

function readJson(absolutePath: string): unknown {
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

/**
 * The recorded pre-D4 definition exactly as captured, with nothing applied.
 *
 * Deliberately raw: these bytes are the evidence, and a reader that quietly
 * migrated them would leave nothing able to prove a fixture is still
 * placement-less. The migration every real load applies belongs to
 * {@link inflateDefinitionFixture}, so a caller states which of the two it
 * means.
 */
export function readDefinitionFixture(scenarioName: string): unknown {
  return readJson(fixturePath(`${scenarioName}.definition.json`));
}

export function readExecutionFixture(scenarioName: string): unknown {
  return readJson(fixturePath(`${scenarioName}.execution.json`));
}

/**
 * A fixture as its stored-load boundary hands it to the parse.
 *
 * The fixtures stay exactly as they were captured — placement-less, because the
 * field did not exist — and the migration that every real load applies is
 * applied here too. Editing placement INTO them would delete the evidence: a
 * pre-placement document is precisely what these files exist to be.
 */
export function inflateDefinitionFixture(scenarioName: string): unknown {
  const raw = readDefinitionFixture(scenarioName);
  migrateRawDefinitionPlacement(raw);
  return raw;
}

export function inflateExecutionFixture(scenarioName: string): unknown {
  const raw = readExecutionFixture(scenarioName);
  migrateRawExecutionPlacement(raw);
  return raw;
}

/**
 * Every turn completes one task. `iteration-halt` never completes its task,
 * which drives the context into its `maxIterations` budget and halts the
 * execution.
 */
const AGENT_SCRIPTS: Record<
  CompatibilityScenarioName,
  CompatibilityScenario["agent"]
> = {
  "linear-chain": () => "complete-next-task",
  "parallel-fan-in": () => "complete-next-task",
  "iteration-halt": () => "no-task-progress",
  "validator-reopen": () => "complete-next-task",
};

/**
 * Absent an entry a context validates on its first attempt. `validator-reopen`
 * refuses `ctx-build` once so the recording covers the reopen-and-retry path:
 * task reopening, the consecutive-failure increment, the failure feedback fed
 * back into the retry prompt, and the eventual pass.
 */
const VALIDATOR_SCRIPTS: Partial<
  Record<CompatibilityScenarioName, CompatibilityScenario["validator"]>
> = {
  "validator-reopen": ({ contextId, attempt }) =>
    contextId === "ctx-build" && attempt === 1
      ? { verdict: "fail", reopenTaskIds: ["task-build-2"] }
      : { verdict: "pass" },
};

const SESSION_LANE_ENABLED: Record<CompatibilityScenarioName, boolean> = {
  "linear-chain": true,
  "parallel-fan-in": false,
  "iteration-halt": true,
  "validator-reopen": true,
};

export function loadCompatibilityScenario(
  scenarioName: CompatibilityScenarioName,
): CompatibilityScenario {
  const validator = VALIDATOR_SCRIPTS[scenarioName];
  return {
    name: scenarioName,
    definition: workflowSemanticDefinitionSchema.parse(
      inflateDefinitionFixture(scenarioName),
    ),
    sessionLaneEnabled: SESSION_LANE_ENABLED[scenarioName],
    agent: AGENT_SCRIPTS[scenarioName],
    ...(validator ? { validator } : {}),
  };
}

export function readCompatibilityRecording(
  scenarioName: string,
): CompatibilityRecording {
  const absolutePath = recordingPath(scenarioName);
  try {
    return compatibilityRecordingSchema.parse(readJson(absolutePath));
  } catch (error) {
    throw new Error(
      `Missing or unreadable pre-D4 recording for "${scenarioName}" at ${absolutePath}. ` +
        `Recordings are committed fixtures; regenerate deliberately with ${RECORDING_UPDATE_ENV}=1.`,
      { cause: error },
    );
  }
}

export function writeCompatibilityRecording(
  recording: CompatibilityRecording,
): void {
  writeFileSync(
    recordingPath(recording.scenario),
    `${JSON.stringify(recording, null, 2)}\n`,
    "utf8",
  );
}
