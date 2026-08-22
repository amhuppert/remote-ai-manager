import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
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
 * File-operation tool activity in a live turn (spec R5.1, R14.2).
 *
 * Text and thinking events are the easy half of the stream. The half that
 * carries risk is tool activity — reads, writes, deletes and searches — because
 * those are the events that carry paths and file content through the transcript
 * boundary, and because they are what a conversation actually does to a
 * workspace. This case makes the agent do all four in one turn and checks both
 * the events and the workspace they claim to have changed.
 */

const SEED_FILE = "acceptance-seed.txt";
const SEED_TOKEN = `SEED-${randomUUID().slice(0, 8).toUpperCase()}`;
const CREATED_FILE = "acceptance-created.txt";
const DOOMED_FILE = "acceptance-doomed.txt";

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;
let live: LiveConversation;
const runId = randomUUID();

function nativeText(
  events: readonly { eventType: string; payload: string }[],
): string {
  return events
    .map((event) => decodeNativePayload(event.eventType, event.payload))
    .map((result) => (result.ok ? JSON.stringify(result.value) : ""))
    .join("");
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });

  live = await harness.startReady({
    sessionName: `file-ops-${randomUUID()}`,
    model: CURSOR_DEFAULT_MODEL,
  });
  writeFileSync(path.join(live.workspace.cwd, SEED_FILE), `${SEED_TOKEN}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(live.workspace.cwd, DOOMED_FILE), "delete me\n", {
    mode: 0o600,
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
      90_000,
    ),
  ).toBe(true);

  live.startTurn({
    runId,
    promptText:
      `In the current directory, do all four of these and then reply with only the word DONE:\n` +
      `1. List the files in the directory.\n` +
      `2. Read ${SEED_FILE} and note the token it contains.\n` +
      `3. Create ${CREATED_FILE} containing exactly that token.\n` +
      `4. Delete ${DOOMED_FILE}.`,
    images: [],
    structuredOutputInstruction: null,
    model: CURSOR_DEFAULT_MODEL,
    mcpServers: {},
    forceExpirePersistedRun: false,
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "turnSettled") !== undefined,
      280_000,
    ),
    "the file-operation turn did not settle",
  ).toBe(true);
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("file-operation tool activity in a live Cursor turn", () => {
  it("completes the turn", () => {
    expect(frameOfType(live.frames, "turnSettled")?.outcome).toBe("completed");
  });

  it("emits tool-call events for the work it did", () => {
    const events = framesOfType(live.frames, "nativeEvent");
    const toolEvents = events.filter(
      (event) => event.eventType === "tool_call",
    );
    expect(
      toolEvents.length,
      "the turn produced no tool activity at all",
    ).toBeGreaterThan(0);
    expect(events.map((event) => event.eventIndex)).toEqual(
      events.map((_event, index) => index),
    );
    expect(framesOfType(live.frames, "nativeEventRejected")).toEqual([]);
  });

  it("actually changed the workspace it reported changing", () => {
    // The events are a claim; the filesystem is the fact. A backend whose tool
    // events described work it never did would pass the assertion above.
    expect(
      existsSync(path.join(live.workspace.cwd, CREATED_FILE)),
      "the agent reported creating a file that does not exist",
    ).toBe(true);
    expect(
      existsSync(path.join(live.workspace.cwd, DOOMED_FILE)),
      "the agent reported deleting a file that is still there",
    ).toBe(false);
  });

  it("carries the read file's content through the native stream", () => {
    expect(nativeText(framesOfType(live.frames, "nativeEvent"))).toContain(
      SEED_TOKEN,
    );
  });

  it("publishes the observed event classes", async () => {
    const events = framesOfType(live.frames, "nativeEvent");
    const byType = new Map<string, number>();
    for (const event of events) {
      byType.set(event.eventType, (byType.get(event.eventType) ?? 0) + 1);
    }

    const raw = await store.writeRaw(
      "file-operations-native-events.jsonl",
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    await store.publish({
      caseId: "streaming-file-operations",
      outcome: "pass",
      metrics: {
        // Bounded: counts per class, never the payloads themselves.
        eventTypes: [...byType.keys()].sort().join(","),
        nativeEventCount: events.length,
        toolCallEvents: byType.get("tool_call") ?? 0,
        assistantEvents: byType.get("assistant") ?? 0,
        thinkingEvents: byType.get("thinking") ?? 0,
        fileCreated: true,
        fileDeleted: true,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [raw],
    });
  });
});
