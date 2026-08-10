import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { runCli } from "@/cli/core";
import type { CliEnv, CliHost } from "@/cli/shared";
import {
  _resetPublicationForTesting,
  setPublicationBroadcastForTesting,
} from "@/lib/events/publication";
import { _resetForTesting as resetJobQueue } from "@/lib/jobs/queue";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";

import type { Refusal, SpecRevision } from "./schemas";
import {
  authorSpineDraft,
  createSpecSpineWorld,
  postJson,
  proposeSpineRevision,
  SPINE_BEARER_TOKEN,
  SPINE_CONVERSATION_ID,
  SPINE_PROJECT_NAME,
  SPINE_SESSION_NAME,
  type SpecSpineWorld,
} from "./spine-test-fixture";

const SLUG = "stranded-proposal";

const cliEnv: CliEnv = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: SPINE_BEARER_TOKEN,
  CC_PROJECT: SPINE_PROJECT_NAME,
  CC_SESSION: SPINE_SESSION_NAME,
  CC_CONVERSATION_ID: SPINE_CONVERSATION_ID,
};

/** Runs the real cctl command implementations against the real route tree. */
function bridgeHost(world: SpecSpineWorld): CliHost {
  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      if (segments[0] !== "api" || segments[1] !== "specs") {
        throw new Error(`Unbridged CLI request path: ${parsed.pathname}`);
      }
      const request = new Request(`http://cc.test${parsed.pathname}`, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      if (init.method === "POST" && segments[4] === "actions") {
        return world.writeHandlers.specActionPOST(request, {
          params: Promise.resolve({
            name: segments[2] ?? "",
            slug: segments[3] ?? "",
            action: segments[5] ?? "",
          }),
        });
      }
      throw new Error(
        `Unbridged CLI request: ${init.method} ${parsed.pathname}`,
      );
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

/**
 * Ticket #50's live shape, built at the repository because the propose guard
 * now prevents the routes from producing it: the plan revision is proposed,
 * and a revision cloned off its approved base is approved above it.
 */
async function strandedSpec(world: SpecSpineWorld): Promise<{
  specId: string;
  stranded: SpecRevision;
  superseding: SpecRevision;
}> {
  const authored = await authorSpineDraft(world, SLUG);
  await proposeSpineRevision(world, SLUG, authored);
  const approvedBase = authored.designRevisionId;
  await world.repos.specs.createDraftFromBase({
    id: "revision-superseding",
    specId: authored.specId,
    baseRevisionId: approvedBase,
    authoringStage: "plan",
    createdAt: "2026-08-06T09:00:00.000Z",
  });
  await world.repos.specs.proposeRevision({
    revisionId: "revision-superseding",
    proposedAt: "2026-08-06T09:00:01.000Z",
  });
  const superseding = await world.repos.specs.approveRevision({
    revisionId: "revision-superseding",
    approvedAt: "2026-08-06T09:00:02.000Z",
  });
  const strandedRevision = await world.repos.specs.findRevision(
    authored.draftRevisionId,
  );
  if (strandedRevision === null) throw new Error("fixture revision missing");
  return { specId: authored.specId, stranded: strandedRevision, superseding };
}

describe("dismiss superseded proposal through the production route", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    world = createSpecSpineWorld();
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
  });

  afterEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetPublicationForTesting();
  });

  it("refuses the agent transport and names the Studio Review surface", async () => {
    const { stranded } = await strandedSpec(world);

    const response = await world.postAction(
      SLUG,
      "dismiss-superseded",
      { revisionId: stranded.id, reason: "forked past" },
      "agent",
    );

    expect(response.status).toBe(403);
    const refusal = (await response.json()) as Refusal;
    expect(refusal.code).toBe("human_act_required");
    expect(refusal.instruction).toContain("Spec Studio → Review");
    // refusals-name-remedy wants the target as well as the remedy: an agent
    // holding several stranded proposals cannot act on "open Review" alone.
    expect(refusal.instruction).toContain(stranded.id);
    expect((await world.repos.specs.findRevision(stranded.id))?.state).toBe(
      "proposed",
    );
  });

  it("answers the agent's cctl attempt with that same refusal", async () => {
    const { stranded } = await strandedSpec(world);

    const result = await runCli(
      [
        "spec",
        "dismiss-superseded",
        SLUG,
        "--revision",
        stranded.id,
        "--reason",
        "forked past",
      ],
      cliEnv,
      bridgeHost(world),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Spec Studio → Review");
    // The receipt the agent actually reads names the revision it refused, so
    // the operator can be handed the exact target without a second lookup.
    expect(result.stderr).toContain(stranded.id);
    expect((await world.repos.specs.findRevision(stranded.id))?.state).toBe(
      "proposed",
    );
  });

  it("commits on human transport with the marker, the audit event, and no draft", async () => {
    const { specId, stranded, superseding } = await strandedSpec(world);

    const value = await postJson<{
      withdrawn: SpecRevision;
      supersession: { supersededByRevisionId: string; reason: string };
    }>(
      world.postAction(
        SLUG,
        "dismiss-superseded",
        {
          revisionId: stranded.id,
          reason: "Revision 4 was approved from the design base.",
        },
        "human",
      ),
    );

    expect(value.withdrawn.state).toBe("withdrawn");
    expect(value.supersession.supersededByRevisionId).toBe(superseding.id);
    expect(await world.repos.specs.findSupersession(stranded.id)).toMatchObject(
      {
        revisionId: stranded.id,
        supersededByRevisionId: superseding.id,
        reason: "Revision 4 was approved from the design base.",
        actor: { kind: "human" },
      },
    );
    expect(await world.repos.specs.findDraft(specId)).toBeNull();
    const audit = world.repos.events
      .findBySpecId(specId)
      .map((row) => ({
        actor: JSON.parse(row.actor_json) as { kind: string },
        payload: JSON.parse(row.payload_json) as { kind?: string },
      }))
      .filter(
        ({ payload }) => payload.kind === "proposal-dismissed-superseded",
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor.kind).toBe("human");
  });
});

describe("approve remaining and sign off through the production route", () => {
  let world: SpecSpineWorld;

  beforeEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    world = createSpecSpineWorld();
    setPublicationBroadcastForTesting(() => ({ delivered: true }));
  });

  afterEach(() => {
    resetJobQueue();
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetPublicationForTesting();
  });

  it("commits on human transport, attributing the approvals and the sign-off to the operator", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);

    const value = await postJson<{
      revision: SpecRevision;
      approval: { approver: string } | null;
      subjectApprovals: Array<{ subject_kind: string; approver: string }>;
    }>(
      world.postAction(
        SLUG,
        "approve-remaining-and-sign-off",
        { revisionId: authored.draftRevisionId },
        "human",
      ),
    );

    expect(value.revision.state).toBe("approved");
    expect(value.subjectApprovals.map((row) => row.subject_kind)).toContain(
      "plan",
    );
    expect(value.approval?.approver).toBe("operator");
    // evidence-legality: the durable sign-off event carries the human actor the
    // authenticated route resolved, not the agent that authored the revision.
    const audit = world.repos.events
      .findBySpecId(authored.specId)
      .filter((row) => row.event_type === "spec-review-revision-signed-off")
      .map((row) => ({
        actor: JSON.parse(row.actor_json) as { kind: string },
        payload: JSON.parse(row.payload_json) as { revisionId?: string },
      }))
      .filter(({ payload }) => payload.revisionId === authored.draftRevisionId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor.kind).toBe("human");
  });

  it("refuses the agent transport and leaves the revision proposed", async () => {
    const authored = await authorSpineDraft(world, SLUG);
    await proposeSpineRevision(world, SLUG, authored);

    const response = await world.postAction(
      SLUG,
      "approve-remaining-and-sign-off",
      { revisionId: authored.draftRevisionId },
      "agent",
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as Refusal).code).toBe(
      "human_act_required",
    );
    expect(
      (await world.repos.specs.findRevision(authored.draftRevisionId))?.state,
    ).toBe("proposed");
  });

  it("inherits the live-sibling guard, naming the stranded revision and its remedy", async () => {
    const { specId, stranded, superseding } = await strandedSpec(world);
    await world.repos.specs.createDraftFromBase({
      id: "revision-successor",
      specId,
      baseRevisionId: superseding.id,
      authoringStage: "plan",
      createdAt: "2026-08-06T09:10:00.000Z",
    });
    const successor = await world.repos.specs.proposeRevision({
      revisionId: "revision-successor",
      proposedAt: "2026-08-06T09:10:01.000Z",
    });
    const approvalsBefore =
      world.repos.review.findApprovalsBySpecId(specId).length;

    const response = await world.postAction(
      SLUG,
      "approve-remaining-and-sign-off",
      { revisionId: successor.id },
      "human",
    );

    expect(response.status).toBe(409);
    const refusal = (await response.json()) as Refusal;
    expect(refusal.code).toBe("revision_in_review");
    expect(refusal.unmetConditions.join(" ")).toContain(stranded.id);
    expect(refusal.instruction).toContain("Dismiss superseded proposal");
    expect(refusal.instruction).toContain(stranded.id);
    expect(world.repos.review.findApprovalsBySpecId(specId)).toHaveLength(
      approvalsBefore,
    );
    expect((await world.repos.specs.findRevision(successor.id))?.state).toBe(
      "proposed",
    );
  });
});
