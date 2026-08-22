import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL, resolveCursorModel } from "../model-policy";
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
  type LiveHarness,
} from "./live-worker";

/**
 * Live model selection (spec R10.1, R10.2, R10.3, R14.2).
 *
 * The load-bearing claim is that Command Center chooses the model rather than
 * letting the provider choose one. That is only observable live in one way: a
 * model id the provider rejects has to FAIL. If a bogus id quietly produced a
 * good answer, the id Command Center sends would be decorative and the default
 * would be provider auto-selection wearing our label.
 */

/** A second real Cursor model, standing in for a project-configured list.
 *  Hard-coded rather than discovered: no path here may call live catalog
 *  discovery, which the spec keeps out of production entirely (D10). */
const LISTED_CUSTOM_MODEL = "composer-2";
const PROJECT_SUPPORTED_MODELS = [CURSOR_DEFAULT_MODEL, LISTED_CUSTOM_MODEL];

const REJECTED_MODEL_ID = "composer-does-not-exist-9x7";

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;

/** Every native payload of a run, flattened — enough to answer "did the model
 *  produce this text", without reimplementing the transcript projection. */
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
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("live Cursor model selection", () => {
  it("selects the default explicitly rather than deferring to the provider", () => {
    const resolution = resolveCursorModel({});
    expect(resolution).toEqual({
      ok: true,
      model: CURSOR_DEFAULT_MODEL,
      source: "default",
      supportedModels: [CURSOR_DEFAULT_MODEL],
    });
  });

  it("refuses an id absent from the project's list before any worker starts", () => {
    const resolution = resolveCursorModel({
      explicitSelection: "gpt-5.6-sol",
      configuredSupportedModels: PROJECT_SUPPORTED_MODELS,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("model_not_supported");
  });

  it("runs a live turn on a listed custom model", async () => {
    const resolution = resolveCursorModel({
      explicitSelection: LISTED_CUSTOM_MODEL,
      configuredSupportedModels: PROJECT_SUPPORTED_MODELS,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");

    const live = await harness.startReady({
      sessionName: `model-custom-${randomUUID()}`,
      model: resolution.model,
    });
    live.attach({
      mode: "create",
      ref: null,
      model: resolution.model,
      mcpServers: {},
    });
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "attachResult") !== undefined,
        60_000,
      ),
    ).toBe(true);
    expect(frameOfType(live.frames, "attachResult")?.outcome).toBe("attached");

    const runId = randomUUID();
    live.startTurn({
      runId,
      promptText: "Reply with exactly MODEL-OK and nothing else.",
      images: [],
      structuredOutputInstruction: null,
      model: resolution.model,
      mcpServers: {},
      forceExpirePersistedRun: false,
    });
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "turnSettled") !== undefined,
        180_000,
      ),
    ).toBe(true);

    expect(frameOfType(live.frames, "turnSettled")?.outcome).toBe("completed");
    expect(nativeText(framesOfType(live.frames, "nativeEvent"))).toContain(
      "MODEL-OK",
    );

    await live.close();
    await store.publish({
      caseId: "model-listed-custom",
      outcome: "pass",
      metrics: { model: resolution.model, source: resolution.source },
      artifacts: [],
    });
  });

  it("applies the declared model on resume, not only on create", async () => {
    // Retention is easy to claim and hard to see: no SDK field reports an
    // agent's active model. What IS observable is that a resume carrying a
    // model the provider rejects fails — which can only happen if the resume
    // path really passes the declared model through rather than reusing
    // whatever the agent was created with.
    const workspace = harness.createWorkspace(`model-resume-${randomUUID()}`);
    const created = await harness.startReady({
      sessionName: workspace.name,
      model: CURSOR_DEFAULT_MODEL,
      workspace,
    });
    created.attach({
      mode: "create",
      ref: null,
      model: CURSOR_DEFAULT_MODEL,
      mcpServers: {},
    });
    expect(
      await waitUntil(
        () => frameOfType(created.frames, "refIssued") !== undefined,
        60_000,
      ),
    ).toBe(true);
    const ref = frameOfType(created.frames, "refIssued")?.ref ?? "";
    expect(ref).toBeTruthy();
    await created.close();

    const resumed = await harness.startReady({
      sessionName: workspace.name,
      model: REJECTED_MODEL_ID,
      workspace,
    });
    resumed.attach({
      mode: "resume",
      ref,
      model: REJECTED_MODEL_ID,
      mcpServers: {},
    });
    expect(
      await waitUntil(
        () => frameOfType(resumed.frames, "attachResult") !== undefined,
        60_000,
      ),
    ).toBe(true);
    const attach = frameOfType(resumed.frames, "attachResult");
    expect(
      attach?.outcome,
      "the resume ignored the declared model and attached anyway",
    ).toBe("failed");
    expect(attach?.error).not.toBeNull();
    await resumed.close();

    await store.publish({
      caseId: "model-applied-on-resume",
      outcome: "pass",
      metrics: {
        createdModel: CURSOR_DEFAULT_MODEL,
        resumeModel: REJECTED_MODEL_ID,
        resumeRefused: true,
        errorName: attach?.error?.name ?? null,
      },
      artifacts: [],
    });
  }, 200_000);

  it("fails bounded on an id the SDK rejects, without substituting another", async () => {
    const live = await harness.startReady({
      sessionName: `model-rejected-${randomUUID()}`,
      model: REJECTED_MODEL_ID,
    });
    live.attach({
      mode: "create",
      ref: null,
      model: REJECTED_MODEL_ID,
      mcpServers: {},
    });

    const runId = randomUUID();
    const settled = await waitUntil(() => {
      const attach = frameOfType(live.frames, "attachResult");
      return attach !== undefined && attach.outcome === "failed";
    }, 60_000);

    // The SDK may reject the model at attach or at run start; both are bounded
    // typed failures, and the case accepts either — what it does not accept is
    // a successful turn on some other model.
    let failure: { name: string | null; code: string | null } | null = null;
    if (settled) {
      const attach = frameOfType(live.frames, "attachResult");
      failure = attach?.error ?? null;
    } else {
      expect(frameOfType(live.frames, "attachResult")?.outcome).toBe(
        "attached",
      );
      live.startTurn({
        runId,
        promptText: "Reply with exactly MODEL-OK and nothing else.",
        images: [],
        structuredOutputInstruction: null,
        model: REJECTED_MODEL_ID,
        mcpServers: {},
        forceExpirePersistedRun: false,
      });
      expect(
        await waitUntil(
          () => frameOfType(live.frames, "turnSettled") !== undefined,
          180_000,
        ),
      ).toBe(true);
      const turn = frameOfType(live.frames, "turnSettled");
      expect(turn?.outcome).not.toBe("completed");
      failure = turn?.error ?? null;
    }

    expect(
      failure,
      "the rejected model produced no typed failure",
    ).not.toBeNull();
    // No substitution: nothing generated an answer on a model nobody selected.
    expect(nativeText(framesOfType(live.frames, "nativeEvent"))).not.toContain(
      "MODEL-OK",
    );

    await live.close();
    await store.publish({
      caseId: "model-sdk-rejected",
      outcome: "pass",
      metrics: {
        requestedModel: REJECTED_MODEL_ID,
        failedAt: settled ? "attach" : "run_start",
        errorName: failure?.name ?? null,
        errorCode: failure?.code ?? null,
        substituted: false,
      },
      artifacts: [],
    });
  });
});
