import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import type { CredentialSecret } from "./credential-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  createLiveHarness,
  frameOfType,
  framesOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
} from "./live-worker";

/**
 * Billed usage against the live provider (ticket #120).
 *
 * One authenticated turn, then the worker's post-turn billing fetch and an
 * on-demand query. The provider decides which of two honest outcomes this
 * account gets: a reported snapshot whose entries are keyed by usage UUID, or
 * a `feature_unavailable` refusal that Command Center records as a durable
 * unavailable state. Either is evidence; a silent absence is the failure.
 */

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;
let live: LiveConversation;
const runId = randomUUID();
const startedAt = Date.now();

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });
  live = await harness.startReady({
    sessionName: "billing",
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
    "the agent did not attach",
  ).toBe(true);
  live.startTurn({
    runId,
    promptText:
      "Reply with exactly the word BILLING-OK and nothing else. Do not use any tools.",
    images: [],
    structuredOutputInstruction: null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers: {},
    forceExpirePersistedRun: false,
    queryBilling: true,
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

describe("billed usage for one authenticated Cursor turn", () => {
  it("reports billing for the run before the turn settles", () => {
    const types = live.frames.map((frame) => frame.type);
    const billingIndex = types.indexOf("billing");
    const settledIndex = types.indexOf("turnSettled");
    expect(billingIndex).toBeGreaterThanOrEqual(0);
    expect(billingIndex).toBeLessThan(settledIndex);
    const billing = frameOfType(live.frames, "billing");
    expect(billing?.runId).toBe(runId);
    expect(billing?.queryId).toBeNull();
  });

  it("reports either a snapshot keyed by usage UUID or an explicit provider refusal", () => {
    const billing = frameOfType(live.frames, "billing");
    expect(billing).toBeDefined();
    if (billing === undefined) return;
    if (billing.outcome === "reported") {
      expect(billing.snapshot.usage.totalTokens).toBeGreaterThan(0);
      for (const entry of billing.snapshot.runs) {
        expect(entry.runId.length).toBeGreaterThan(0);
        expect(entry.runId.startsWith("run-")).toBe(false);
        expect(entry.usage.totalTokens).toBeGreaterThan(0);
      }
      return;
    }
    // The refusal is the account's, not a transport fault: a bounded typed
    // error with the provider's stable code and status.
    expect(billing.outcome).toBe("unavailable");
    expect(billing.error.code).toBe("feature_unavailable");
    expect(billing.error.status).toBe(403);
  });

  it("answers an on-demand query the same way, then publishes the evidence", async () => {
    live.session.queryUsage("acceptance-query");
    expect(
      await waitUntil(
        () =>
          framesOfType(live.frames, "billing").some(
            (frame) => frame.queryId === "acceptance-query",
          ),
        30_000,
      ),
      "the usage query was not answered",
    ).toBe(true);
    const postTurn = frameOfType(live.frames, "billing");
    const queried = framesOfType(live.frames, "billing").find(
      (frame) => frame.queryId === "acceptance-query",
    );
    expect(queried?.outcome).toBe(postTurn?.outcome);

    const usage = framesOfType(live.frames, "usage").at(0);
    const raw = await store.writeRaw(
      "billing-frames.jsonl",
      `${framesOfType(live.frames, "billing")
        .map((frame) => JSON.stringify(frame))
        .join("\n")}\n`,
    );
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    const reported = postTurn?.outcome === "reported" ? postTurn : null;
    await store.publish({
      caseId: "billing-one-turn",
      outcome: "pass",
      metrics: {
        model: CURSOR_DEFAULT_MODEL,
        billingOutcome: postTurn?.outcome ?? null,
        providerCode:
          postTurn?.outcome === "reported"
            ? null
            : (postTurn?.error.code ?? null),
        providerStatus:
          postTurn?.outcome === "reported"
            ? null
            : (postTurn?.error.status ?? null),
        entryCount: reported?.snapshot.runs.length ?? null,
        entriesWithCost:
          reported?.snapshot.runs.filter((entry) => entry.cost !== null)
            .length ?? null,
        agentChargedCents: reported?.snapshot.cost?.chargedCents ?? null,
        agentRawCostCents: reported?.snapshot.cost?.rawCostCents ?? null,
        streamTotalTokens: usage?.totalTokens ?? null,
        billedTotalTokens: reported?.snapshot.usage.totalTokens ?? null,
        elapsedMs: Date.now() - startedAt,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [raw],
    });
  });
});
