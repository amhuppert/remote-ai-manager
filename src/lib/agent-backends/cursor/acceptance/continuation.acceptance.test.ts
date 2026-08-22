import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import { decodeNativePayload } from "../worker/ipc";
import type { CredentialSecret } from "./credential-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  frameOfType,
  framesOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
  type LiveWorkspace,
} from "./live-worker";

/**
 * Continuation across a worker restart (spec R7.1, R7.3, R14.2).
 *
 * The conversation has to survive the process, not just the request. A second
 * worker resuming the persisted ref must recall what the first turn said, keep
 * the declared model, and — the part that is easy to get wrong — must NOT
 * re-emit the prior turn as new stream events, because a consumer replaying the
 * whole history on every resume would duplicate the transcript.
 */

const MARKER = `MARKER-${randomUUID().slice(0, 8).toUpperCase()}`;

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;
let workspace: LiveWorkspace;
let ref: string;
let resumed: LiveConversation;
const firstRunId = randomUUID();
const resumedRunId = randomUUID();

function nativeText(
  events: readonly { eventType: string; payload: string }[],
): string {
  return events
    .map((event) => decodeNativePayload(event.eventType, event.payload))
    .map((result) => (result.ok ? JSON.stringify(result.value) : ""))
    .join("");
}

async function settleTurn(live: LiveConversation): Promise<void> {
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "turnSettled") !== undefined,
      180_000,
    ),
    "the turn did not settle",
  ).toBe(true);
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });
  workspace = harness.createWorkspace(`continuation-${randomUUID()}`);

  const original = await harness.startReady({
    sessionName: workspace.name,
    model: CURSOR_DEFAULT_MODEL,
    workspace,
  });
  original.attach({
    mode: "create",
    ref: null,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
  });
  expect(
    await waitUntil(
      () => frameOfType(original.frames, "refIssued") !== undefined,
      60_000,
    ),
  ).toBe(true);
  ref = frameOfType(original.frames, "refIssued")?.ref ?? "";
  expect(ref).toBeTruthy();

  original.startTurn({
    runId: firstRunId,
    promptText: `Remember this token for later: ${MARKER}. Reply with exactly REMEMBERED and nothing else.`,
    images: [],
    structuredOutputInstruction: null,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
    forceExpirePersistedRun: false,
  });
  await settleTurn(original);
  expect(frameOfType(original.frames, "turnSettled")?.outcome).toBe(
    "completed",
  );

  // The owning worker goes away entirely — this is a restart, not a second
  // turn on a live agent.
  const closed = await original.close();
  expect(closed.kind).toBe("verified");

  resumed = await harness.startReady({
    sessionName: workspace.name,
    model: CURSOR_DEFAULT_MODEL,
    workspace,
  });
  expect(resumed.session.pid).not.toBe(original.session.pid);
  resumed.attach({
    mode: "resume",
    ref,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
  });
  expect(
    await waitUntil(
      () => frameOfType(resumed.frames, "attachResult") !== undefined,
      60_000,
    ),
  ).toBe(true);

  resumed.startTurn({
    runId: resumedRunId,
    promptText:
      "What token did I ask you to remember? Reply with only that token and nothing else.",
    images: [],
    structuredOutputInstruction: null,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
    forceExpirePersistedRun: false,
  });
  await settleTurn(resumed);
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("Cursor continuation across a worker restart", () => {
  it("attaches the new worker to the persisted ref", () => {
    const attached = frameOfType(resumed.frames, "attachResult");
    expect(attached?.outcome).toBe("attached");
    expect(attached?.error).toBeNull();
  });

  it("recalls the marker only the prior worker's turn established", () => {
    expect(frameOfType(resumed.frames, "turnSettled")?.outcome).toBe(
      "completed",
    );
    expect(nativeText(framesOfType(resumed.frames, "nativeEvent"))).toContain(
      MARKER,
    );
  });

  it("emits no prior-turn content as new stream events", () => {
    const events = framesOfType(resumed.frames, "nativeEvent");
    // Every forwarded event belongs to the run this worker started. A replayed
    // history would arrive under the prior run's id or with no run at all.
    expect(events.every((event) => event.runId === resumedRunId)).toBe(true);
    expect(events.some((event) => event.runId === firstRunId)).toBe(false);

    // The prior turn's assistant answer is not restated as a new event. The
    // marker itself IS expected — the model was asked to repeat it.
    expect(nativeText(events)).not.toContain("REMEMBERED");
  });

  it("reports one usage record for the resumed turn", () => {
    const usage = framesOfType(resumed.frames, "usage");
    expect(usage).toHaveLength(1);
    expect(usage.at(0)?.runId).toBe(resumedRunId);
    expect(usage.at(0)?.totalTokens).toBeGreaterThan(0);
  });

  it("publishes the continuation evidence and closes cleanly", async () => {
    const usage = framesOfType(resumed.frames, "usage").at(0);
    const outcome = await resumed.close();
    expect(outcome.kind).toBe("verified");

    await store.publish({
      caseId: "continuation-restart",
      outcome: "pass",
      metrics: {
        markerRecalled: true,
        replayedEvents: 0,
        model: CURSOR_DEFAULT_MODEL,
        resumedUsageRecords: 1,
        resumedTotalTokens: usage?.totalTokens ?? null,
        costUsd: null,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [],
    });
  });
});

describe("Cursor continuation ref rejections", () => {
  it("refuses a stale, corrupt, and cross-workspace ref without attaching", async () => {
    const cases: readonly {
      id: string;
      ref: string;
      sameWorkspace: boolean;
    }[] = [
      {
        id: "random",
        ref: `agent-${randomUUID()}`,
        sameWorkspace: true,
      },
      { id: "corrupt", ref: "not-an-agent-ref", sameWorkspace: true },
      { id: "cross-cwd", ref, sameWorkspace: false },
    ];

    const observed: Record<string, string | boolean | number | null> = {};

    for (const testCase of cases) {
      const live = await harness.startReady({
        sessionName: `ref-${testCase.id}-${randomUUID()}`,
        model: CURSOR_DEFAULT_MODEL,
        ...(testCase.sameWorkspace ? { workspace } : {}),
      });
      live.attach({
        mode: "resume",
        ref: testCase.ref,
        model: CURSOR_DEFAULT_MODEL,
        mcpServers: {},
      });
      expect(
        await waitUntil(
          () => frameOfType(live.frames, "attachResult") !== undefined,
          60_000,
        ),
        `${testCase.id}: attach never settled`,
      ).toBe(true);

      const attach = frameOfType(live.frames, "attachResult");
      expect(attach?.outcome, `${testCase.id} attached anyway`).toBe("failed");
      expect(attach?.ref, `${testCase.id} returned a ref`).toBeNull();
      expect(
        attach?.error,
        `${testCase.id} carried no typed error`,
      ).not.toBeNull();
      observed[`${testCase.id}ErrorName`] = attach?.error?.name ?? null;

      const closed = await live.close();
      expect(closed.kind, `${testCase.id} left state behind`).toBe("verified");
    }

    await store.publish({
      caseId: "continuation-invalid-refs",
      outcome: "pass",
      metrics: { ...observed, attachedAnyway: false },
      artifacts: [],
    });
  });
});
