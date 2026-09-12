import { basename } from "node:path";
import { BaseSequencer, startVitest } from "vitest/node";
import {
  CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE,
  formatCursorAcceptanceVerdict,
  resolveCursorAcceptanceGate,
} from "./cursor-acceptance-gate.mjs";

/**
 * The closing credential sweep (`final-*`) must run after every live case has
 * written its fixtures — it walks the evidence tree and fails on an empty
 * surface. The config's include list already orders `final-*` last, but the
 * default sequencer reorders files by cached duration from the previous run,
 * which moved the sweep ahead of the cases it audits. Pinning the rank here
 * makes the ordering a property of the command, not of the cache.
 */
class FinalSweepLastSequencer extends BaseSequencer {
  async sort(files) {
    const sorted = await super.sort(files);
    const rank = (spec) =>
      basename(spec.moduleId).startsWith("final-") ? 1 : 0;
    return [...sorted].sort((left, right) => rank(left) - rank(right));
  }
}

/**
 * Entry point for the registered `cursor-acceptance` validation command.
 *
 * Runs in two modes so the gate can be answered before the wrapper does
 * anything destructive. `--gate-only` reports a refusal and exits, and is
 * silent when the environment is ready — the wrapper is mid-setup at that
 * point and a "ready" line there would be premature. Without the flag the
 * verdict is printed and the suite runs.
 */

const gateOnly = process.argv.includes("--gate-only");
const gate = resolveCursorAcceptanceGate(process.env);

if (gate.state === "blocked") {
  process.stdout.write(`${formatCursorAcceptanceVerdict(gate)}\n`);
  process.exit(CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE);
}
if (gateOnly) {
  process.exit(0);
}
process.stdout.write(`${formatCursorAcceptanceVerdict(gate)}\n`);

// One fork, one file at a time. The suite makes claims about host process
// tables — that no worker, tool, or MCP process survived a cancellation — and
// a concurrent acceptance file's processes would be indistinguishable from a
// leak. `passWithNoTests` stays false so an empty include list is a failure
// rather than the vacuous pass this command exists to prevent.
await startVitest("test", process.argv.slice(2), {
  run: true,
  color: false,
  reporters: ["dot"],
  bail: 0,
  passWithNoTests: false,
  project: ["cursor-acceptance"],
  pool: "forks",
  fileParallelism: false,
  maxWorkers: 1,
  minWorkers: 1,
  poolOptions: {
    forks: { maxForks: 1, minForks: 1, singleFork: true },
  },
  sequence: { sequencer: FinalSweepLastSequencer },
});
