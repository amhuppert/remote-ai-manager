import path from "node:path";
import {
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  createLiveHarness,
} from "./live-worker";

/**
 * A stand-in Command Center server for the orphan-lifetime acceptance case
 * (spec R9.5, R14.2).
 *
 * The claim is about what happens when the server dies WITHOUT an orderly
 * shutdown, and a test process cannot make that claim about itself — killing
 * the runner kills the assertions too. So this script becomes the parent: it
 * starts one real worker exactly the way the supervisor does, reports the
 * worker's identity on stdout, and then does nothing until it is killed.
 *
 * It reads the credential from `CURSOR_API_KEY`, the same variable a real
 * server reads. That spelling is load-bearing: the supervisor strips exactly
 * that key from every worker environment it builds, so a fixture that invented
 * its own variable name would smuggle the credential into the worker it spawned
 * and quietly break the containment the suite exists to prove.
 */

async function main(): Promise<void> {
  const credential = process.env["CURSOR_API_KEY"] ?? null;
  const evidenceRoot = process.env["CURSOR_ACCEPTANCE_PARENT_ROOT"];
  const sessionName = process.env["CURSOR_ACCEPTANCE_PARENT_SESSION"];
  if (
    credential === null ||
    evidenceRoot === undefined ||
    sessionName === undefined
  ) {
    throw new Error("the orphan parent was started without its configuration");
  }

  const harness = createLiveHarness({
    credential,
    evidenceRoot: path.join(evidenceRoot, "orphan-parent"),
  });
  const live = await harness.startReady({
    sessionName,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  });

  process.stdout.write(`${JSON.stringify({ workerPid: live.session.pid })}\n`);

  // Never resolves: this process exists to be killed.
  await new Promise(() => {});
}

void main();
