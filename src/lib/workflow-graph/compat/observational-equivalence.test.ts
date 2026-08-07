import { describe, expect, it } from "vitest";
import { recordCompatibilityScenario } from "./engine-harness";
import {
  COMPATIBILITY_SCENARIOS,
  RECORDING_UPDATE_ENV,
  loadCompatibilityScenario,
  readCompatibilityRecording,
  writeCompatibilityRecording,
} from "./scenarios";

/**
 * R14.1 / decision D14. Each committed recording under `recordings/` was
 * produced by this harness against the pre-D4 engine; the D4-enabled engine
 * must reproduce it exactly. A recording is regenerated ONLY by an explicit
 * `<RECORDING_UPDATE_ENV>=1` run, and regenerating one is an assertion that the
 * observable pre-D4 behaviour genuinely changed — the whole point of the fixture
 * is that additive D4 work leaves it untouched.
 */
describe("pre-D4 observational equivalence", () => {
  for (const scenarioName of COMPATIBILITY_SCENARIOS) {
    it(`reproduces the recorded projections for "${scenarioName}"`, async () => {
      const scenario = loadCompatibilityScenario(scenarioName);
      const observed = await recordCompatibilityScenario(scenario);

      if (process.env[RECORDING_UPDATE_ENV] === "1") {
        writeCompatibilityRecording(observed);
      }

      expect(observed).toEqual(readCompatibilityRecording(scenarioName));
    }, 60_000);
  }

  /**
   * The recordings are only evidence of PRE-D4 ENGINE behaviour if the engine
   * layers D4 will change actually ran. The iteration path (seed → task binding
   * → completion → context validation → finalize) is the layer a hand-written
   * stand-in most easily elides, and its verdict events are the cheapest proof
   * it ran: nothing else in the engine emits `graph-workflow-validation-result`.
   */
  it("drives the production context-validation path for every context that completes", async () => {
    const observed = await recordCompatibilityScenario(
      loadCompatibilityScenario("linear-chain"),
    );

    expect(
      observed.events
        .filter((event) => event.kind === "graph-workflow-validation-result")
        .map((event) => `${event.subject}:${event.detail}`),
    ).toEqual(["ctx-plan:pass", "ctx-build:pass", "ctx-verify:pass"]);
  }, 60_000);

  /**
   * The other half of the iteration path: a refused verdict must reopen the
   * task it named, run the context again, and only then complete. Pinning the
   * reopened task's own status trail keeps the corpus sensitive to a D4 change
   * that alters how a context re-enters after a failed validation.
   */
  it("records the production reopen-and-retry path when a context validator refuses", async () => {
    const observed = await recordCompatibilityScenario(
      loadCompatibilityScenario("validator-reopen"),
    );

    expect(
      observed.events
        .filter(
          (event) =>
            event.kind === "graph-workflow-validation-result" &&
            event.subject === "ctx-build",
        )
        .map((event) => event.detail),
    ).toEqual(["fail", "pass"]);
    expect(
      observed.events
        .filter(
          (event) =>
            event.kind === "graph-workflow-task-status" &&
            event.subject === "task-build-2",
        )
        .map((event) => event.detail),
    ).toEqual(["pending", "pending", "completed", "pending", "completed"]);
  }, 60_000);

  it("records identical projections across repeated runs of the same scenario", async () => {
    const scenario = loadCompatibilityScenario("parallel-fan-in");
    const first = await recordCompatibilityScenario(scenario);
    const second = await recordCompatibilityScenario(scenario);

    expect(second).toEqual(first);
  }, 60_000);
});
