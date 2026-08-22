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
} from "./live-worker";

/**
 * The ordinary authenticated turn (spec R5.1, R8.1, R9.1, R14.2).
 *
 * One live conversation on the default model, carrying the claims every other
 * case builds on: the model is chosen explicitly rather than left to provider
 * auto-selection, the continuation ref is issued eagerly, native events arrive
 * ordered under one run id, the turn produces exactly one usage record with no
 * cost, and close leaves no process behind.
 */

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;
let live: LiveConversation;
const runId = randomUUID();

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });

  live = await harness.startReady({
    sessionName: "streaming",
    model: CURSOR_DEFAULT_MODEL,
  });
  live.attach({
    mode: "create",
    ref: null,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "attachResult") !== undefined,
      60_000,
    ),
    "the agent did not attach",
  ).toBe(true);

  live.startTurn({
    runId,
    promptText:
      "Reply with exactly the word ACCEPTANCE-OK and nothing else. Do not use any tools.",
    images: [],
    structuredOutputInstruction: null,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
    forceExpirePersistedRun: false,
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "turnSettled") !== undefined,
      180_000,
    ),
    "the turn did not settle",
  ).toBe(true);
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("ordinary authenticated Cursor turn", () => {
  it("attaches on the explicitly selected default model", () => {
    const attached = frameOfType(live.frames, "attachResult");
    expect(attached?.outcome).toBe("attached");
    expect(attached?.error).toBeNull();
  });

  it("issues the continuation ref eagerly, before the turn settles", () => {
    const refIssued = frameOfType(live.frames, "refIssued");
    expect(refIssued?.ref).toBeTruthy();
    // The tested SDK reveals the agent id at create, so the ref frame precedes
    // every native event of the first run — which is what makes persisting it
    // eagerly (D8) possible at all.
    const refIndex = live.frames.findIndex(
      (frame) => frame.type === "refIssued",
    );
    const firstEventIndex = live.frames.findIndex(
      (frame) => frame.type === "nativeEvent",
    );
    expect(refIndex).toBeGreaterThanOrEqual(0);
    expect(refIndex).toBeLessThan(firstEventIndex);
  });

  it("settles the turn as completed", () => {
    const settled = frameOfType(live.frames, "turnSettled");
    expect(settled?.outcome).toBe("completed");
    expect(settled?.error).toBeNull();
  });

  it("forwards native events ordered and monotonically indexed under one run", () => {
    const events = framesOfType(live.frames, "nativeEvent");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.runId === runId)).toBe(true);
    expect(events.map((event) => event.eventIndex)).toEqual(
      events.map((_event, index) => index),
    );
    expect(framesOfType(live.frames, "nativeEventRejected")).toEqual([]);
  });

  it("carries assistant text through the lossless native envelope", () => {
    const decoded = framesOfType(live.frames, "nativeEvent").map((event) =>
      decodeNativePayload(event.eventType, event.payload),
    );
    expect(decoded.every((result) => result.ok)).toBe(true);
    const text = decoded
      .map((result) => (result.ok ? JSON.stringify(result.value) : ""))
      .join("");
    expect(text).toContain("ACCEPTANCE-OK");
  });

  it("reports exactly one usage record for the turn", () => {
    const usage = framesOfType(live.frames, "usage");
    expect(usage).toHaveLength(1);
    const record = usage.at(0);
    expect(record?.runId).toBe(runId);
    expect(record?.inputTokens).toBeGreaterThan(0);
    expect(record?.outputTokens).toBeGreaterThan(0);
    expect(record?.totalTokens).toBeGreaterThan(0);
  });

  it("closes with verified teardown and publishes the evidence", async () => {
    const events = framesOfType(live.frames, "nativeEvent");
    const usage = framesOfType(live.frames, "usage").at(0);
    const raw = await store.writeRaw(
      "streaming-native-events.jsonl",
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    await store.publish({
      caseId: "streaming-ordinary-turn",
      outcome: "pass",
      metrics: {
        model: CURSOR_DEFAULT_MODEL,
        nativeEventCount: events.length,
        distinctEventTypes: new Set(events.map((event) => event.eventType))
          .size,
        usageRecords: 1,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        // Phase 1 reports no cost: the SDK settles billed usage as
        // feature_unavailable, so nothing is estimated (D17).
        costUsd: null,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [raw],
    });
  });
});
