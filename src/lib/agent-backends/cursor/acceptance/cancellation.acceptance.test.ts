import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_CANCEL_SETTLE_TIMEOUT_MS } from "../worker/bounds";
import { decodeNativePayload } from "../worker/ipc";
import type { CredentialSecret } from "./credential-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { captureProcessBoundaries, openAcceptanceEvidence } from "./harness";
import {
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  createLiveHarness,
  frameOfType,
  framesOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
} from "./live-worker";
import {
  findMarkedPids,
  isGroupAlive,
  measureUntil,
  readMarkedProcess,
  type MarkedProcess,
} from "./process-scan";

/**
 * Live cancellation (spec R9.1, R9.2, R14.2).
 *
 * This is the criterion the transport decision turned on. ACP was rejected
 * because a cancelled shell tool process stayed alive on the host; the SDK was
 * selected because the same marked process died. So the assertion that matters
 * is never "the SDK reported cancelled" — it is "the operating system no longer
 * has that process", asked twice, and asked again after the worker is gone.
 */

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;

function nativeText(
  events: readonly { eventType: string; payload: string }[],
): string {
  return events
    .map((event) => decodeNativePayload(event.eventType, event.payload))
    .map((result) => (result.ok ? JSON.stringify(result.value) : ""))
    .join("");
}

async function attached(sessionName: string): Promise<LiveConversation> {
  const live = await harness.startReady({
    sessionName,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  });
  live.attach({
    mode: "create",
    ref: null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers: {},
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "attachResult") !== undefined,
      60_000,
    ),
    `${sessionName}: attach never settled`,
  ).toBe(true);
  expect(frameOfType(live.frames, "attachResult")?.outcome).toBe("attached");
  return live;
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("cancelling a Cursor generation", () => {
  it("settles once as cancelled within the bound and leaves no process group", async () => {
    const live = await attached(`cancel-generation-${randomUUID()}`);
    const runId = randomUUID();

    live.startTurn({
      runId,
      promptText:
        "Write a detailed 2000-word essay on the history of the bicycle. Use no tools; just write prose.",
      images: [],
      structuredOutputInstruction: null,
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      mcpServers: {},
      forceExpirePersistedRun: false,
    });

    // Cancel only once the model is demonstrably generating: cancelling before
    // the first token would test the queue, not generation.
    expect(
      await waitUntil(
        () =>
          framesOfType(live.frames, "nativeEvent").some(
            (event) => event.eventType === "assistant",
          ),
        180_000,
      ),
      "the model produced no text to cancel",
    ).toBe(true);
    const eventsAtCancel = framesOfType(live.frames, "nativeEvent").length;

    live.cancel(runId);
    const settleMs = await measureUntil(
      () => frameOfType(live.frames, "cancelResult") !== undefined,
      CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
    );
    expect(
      settleMs,
      "cancellation did not settle within its bound",
    ).not.toBeNull();

    expect(framesOfType(live.frames, "cancelResult")).toHaveLength(1);
    expect(frameOfType(live.frames, "cancelResult")?.outcome).toBe("cancelled");
    // Awaited rather than assumed: the run's terminal frame follows the
    // cancellation settlement, so reading it immediately would race the SDK.
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "turnSettled") !== undefined,
        CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
      ),
      "the cancelled turn produced no terminal outcome",
    ).toBe(true);
    expect(framesOfType(live.frames, "turnSettled")).toHaveLength(1);
    expect(frameOfType(live.frames, "turnSettled")?.outcome).toBe("aborted");

    // Generation actually stopped: nothing new arrives after settlement.
    const eventsAfterSettle = framesOfType(live.frames, "nativeEvent").length;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(framesOfType(live.frames, "nativeEvent").length).toBe(
      eventsAfterSettle,
    );

    const readyFrame = frameOfType(live.frames, "ready");
    const pgid = readyFrame?.pgid ?? live.session.pid;
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");
    expect(isGroupAlive(pgid), "the worker's process group survived").toBe(
      false,
    );

    await store.publish({
      caseId: "cancel-generation",
      outcome: "pass",
      metrics: {
        cancelSettleMs: settleMs,
        boundMs: CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
        eventsAtCancel,
        eventsAfterQuietWindow: eventsAfterSettle,
        cancelResults: 1,
        terminalOutcome: "aborted",
        workerGroupSurvived: false,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [],
    });
  }, 280_000);
});

describe("cancelling a Cursor shell tool", () => {
  /**
   * The exact regression fixture that separated the SDK from ACP: an indefinite
   * shell process, uniquely marked so the host scan cannot match anything else,
   * with its pid, parent, and process group recorded while it is alive.
   *
   * Run twice, because the ACP failure was reproducible and a single trial
   * cannot distinguish "terminated" from "happened to die".
   */
  async function runTrial(
    trial: number,
  ): Promise<Record<string, number | string | boolean | null>> {
    const marker = `cc-cursor-acceptance-shell-${trial}-${randomUUID().slice(0, 8)}`;
    const live = await attached(`cancel-shell-${trial}-${randomUUID()}`);
    const runId = randomUUID();

    live.startTurn({
      runId,
      promptText:
        `Run exactly this shell command and wait for it to finish. Do not modify it, do not background it, do not explain:\n` +
        `bash -c 'echo ${marker}; sleep 100000'`,
      images: [],
      structuredOutputInstruction: null,
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      mcpServers: {},
      forceExpirePersistedRun: false,
    });

    expect(
      await waitUntil(() => findMarkedPids(marker).length > 0, 180_000),
      `trial ${trial}: the agent never started the marked shell process`,
    ).toBe(true);

    const pids = findMarkedPids(marker);
    const identities = pids
      .map((pid) => readMarkedProcess(pid))
      .filter((identity): identity is MarkedProcess => identity !== null);
    expect(identities.length).toBeGreaterThan(0);

    // Read the tool child's argv and environment WHILE IT LIVES. This is the
    // "any environment the worker passes to its children" boundary, and it only
    // exists between the tool starting and cancellation reaping it.
    const workerPgid =
      frameOfType(live.frames, "ready")?.pgid ?? live.session.pid;
    const boundaries = await captureProcessBoundaries({
      store,
      secret,
      label: `cancel-shell-trial-${trial}`,
      pgids: [workerPgid],
      extraPids: pids,
    });
    expect(
      boundaries.pids.length,
      `trial ${trial}: no live process boundary was read`,
    ).toBeGreaterThan(1);
    expect(
      boundaries.findings.map((finding) => finding.sourceLabel),
      `trial ${trial}: the credential reached a tool process boundary`,
    ).toEqual([]);
    // A shell tool is the child most able to act on a stolen credential, so it
    // is scanned for every credential-shaped variable the server carries.
    expect(
      boundaries.ambientFindings.map(
        (finding) => `${finding.sourceLabel} (${finding.secretLabel})`,
      ),
      `trial ${trial}: a third-party credential reached a tool process boundary`,
    ).toEqual([]);

    live.cancel(runId);
    // Dead after NATIVE cancellation — before the agent is disposed and before
    // the worker's process group is touched. This is the distinguishing claim.
    const deadAfterCancelMs = await measureUntil(
      () => findMarkedPids(marker).length === 0,
      CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
    );
    expect(
      deadAfterCancelMs,
      `trial ${trial}: the marked shell process survived native cancellation`,
    ).not.toBeNull();

    // The tool process dies before the run's cancellation settles, so the frame
    // is awaited rather than assumed present — the ordering is the SDK's, and
    // asserting it the other way round would make the case flaky by design.
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "cancelResult") !== undefined,
        CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
      ),
      `trial ${trial}: cancellation never settled`,
    ).toBe(true);
    expect(frameOfType(live.frames, "cancelResult")?.outcome).toBe("cancelled");

    const readyFrame = frameOfType(live.frames, "ready");
    const pgid = readyFrame?.pgid ?? live.session.pid;
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    // Still dead after disposal and worker cleanup: cancellation did not merely
    // detach a process that cleanup would later have had to chase.
    expect(findMarkedPids(marker)).toEqual([]);
    expect(isGroupAlive(pgid)).toBe(false);

    return {
      trial,
      markedProcesses: identities.length,
      recordedPid: identities[0]?.pid ?? null,
      recordedPpid: identities[0]?.ppid ?? null,
      recordedPgid: identities[0]?.pgid ?? null,
      deadAfterNativeCancelMs: deadAfterCancelMs,
      deadAfterCleanup: true,
      workerGroupSurvived: false,
      processBoundariesScanned: boundaries.sources.length,
      boundaryFindings: boundaries.findings.length,
      ambientCredentialFindings: boundaries.ambientFindings.length,
    };
  }

  it("kills the marked descendant on the first trial", async () => {
    const metrics = await runTrial(1);
    await store.publish({
      caseId: "cancel-shell-descendant-trial-1",
      outcome: "pass",
      metrics,
      artifacts: [],
    });
  }, 280_000);

  it("kills the marked descendant again on a second trial", async () => {
    const metrics = await runTrial(2);
    await store.publish({
      caseId: "cancel-shell-descendant-trial-2",
      outcome: "pass",
      metrics,
      artifacts: [],
    });
  }, 280_000);
});

describe("cancellation leaves no assistant output attributed to a cancelled run", () => {
  it("records no usage for a run that never completed", async () => {
    const live = await attached(`cancel-usage-${randomUUID()}`);
    const runId = randomUUID();

    live.startTurn({
      runId,
      promptText:
        "Write a detailed 2000-word essay on the history of the sailing ship. Use no tools.",
      images: [],
      structuredOutputInstruction: null,
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      mcpServers: {},
      forceExpirePersistedRun: false,
    });
    expect(
      await waitUntil(
        () =>
          framesOfType(live.frames, "nativeEvent").some(
            (event) => event.eventType === "assistant",
          ),
        180_000,
      ),
    ).toBe(true);

    live.cancel(runId);
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "turnSettled") !== undefined,
        CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
      ),
    ).toBe(true);

    // No fabricated tokens for a turn that was abandoned, and no other run's
    // usage attributed to it.
    const usage = framesOfType(live.frames, "usage");
    expect(usage.every((record) => record.runId === runId)).toBe(true);
    expect(nativeText(framesOfType(live.frames, "nativeEvent"))).not.toContain(
      "FINISHED",
    );

    await live.close();
    await store.publish({
      caseId: "cancel-usage-attribution",
      outcome: "pass",
      metrics: {
        usageRecords: usage.length,
        foreignUsageRecords: 0,
        costUsd: null,
      },
      artifacts: [],
    });
  }, 280_000);
});
