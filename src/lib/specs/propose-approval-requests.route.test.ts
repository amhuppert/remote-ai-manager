import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import type { SpecNotification } from "@/lib/notifications/schemas";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";

import { createAuthoringService } from "./authoring-service";
import { createSpecEventsPublisher } from "./events";
import { createReviewService } from "./review-service";
import {
  createSpecWriteRouteHandlers,
  SPEC_CALLER_CONVERSATION_HEADER,
  type SpecMutationServices,
} from "./route-handlers";
import { specProposeResultViewSchema } from "./view-schemas";

const PROJECT_PATH = "/repos/propose-approval-requests";
const PROJECT_NAME = "propose-approval-requests-project";
const SLUG = "auto-filed";
const CONVERSATION_ID = "conversation-authoring";

const auth: AgentAuth = {
  async requireToken(request) {
    const result = await this.validateOptionalToken(request);
    return result.kind === "valid"
      ? null
      : Response.json({ error: "Invalid token" }, { status: 401 });
  },
  async validateOptionalToken(request) {
    const value = request.headers.get("authorization");
    if (value === null) return { kind: "absent" };
    return value === "Bearer valid" ? { kind: "valid" } : { kind: "invalid" };
  },
};

/**
 * R10.13 end to end: the propose HTTP action a CLI or a Studio client calls
 * must leave the durable asks behind, through the composition the service
 * factory builds — the authoring service filing through the review service's
 * own `requestApproval`, not through a second request path of its own.
 */
describe("propose route files the gate asks it leaves pending", () => {
  let db: Db;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
  let handlers: ReturnType<typeof createSpecWriteRouteHandlers>;
  let specId: string;
  let revisionId: string;

  beforeEach(async () => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    const specs = createSpecsRepo(db, createWriteQueue());
    const reviewRepo = createSpecReviewRepo(db);
    const linksRepo = createSpecLinksRepo(db);
    const deliveryRepo = createSpecDeliveryRepo(db);
    const eventsRepo = createSpecEventsRepo(db);
    const events = createSpecEventsPublisher({
      appendInTransaction: eventsRepo.appendInTransaction,
      publish: () => ({ delivered: true }),
    });
    notificationsRepo = createNotificationsRepo(db);
    const notifications = createNotificationsService({
      repo: () => notificationsRepo,
      publish: () => ({ delivered: true }),
      dispatchPush: () => {},
    });
    const notifier = createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(id) {
        return notificationsRepo.findSpecNotificationsBySpecId(id);
      },
      getProjectDisplayName: () => PROJECT_NAME,
    });
    const review = createReviewService({
      specs,
      review: reviewRepo,
      delivery: deliveryRepo,
      links: linksRepo,
      events,
      attention: eventsRepo,
      notifier,
      policyNotifier: notifier,
    });
    // The service factory's composition: authoring is built after review so a
    // propose can file through the same request verb a human or an agent calls.
    const authoring = createAuthoringService({
      specs,
      review: reviewRepo,
      links: linksRepo,
      events,
      waivers: deliveryRepo,
      policyNotifier: notifier,
      approvalRequests: {
        requestApproval: (input) => review.requestApproval(input),
      },
    });
    // Only the propose action is exercised; the remaining service bag members
    // are never reached from it.
    const services = { authoring, review } as unknown as SpecMutationServices;
    handlers = createSpecWriteRouteHandlers({
      auth,
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      resolveSpec: (projectPath, slug) => specs.resolve(projectPath, slug),
      getServices: async () => services,
      listRevisions: (id) => specs.listRevisions(id),
      getRevisionSnapshot: (id) => specs.getRevisionSnapshot(id),
      findQuestionsBySpecId: (id) => reviewRepo.findQuestionsBySpecId(id),
      findAssumptionsBySpecId: (id) => reviewRepo.findAssumptionsBySpecId(id),
      findEventsBySpecId: (id) => eventsRepo.findBySpecId(id),
    });

    const actor = {
      kind: "agent",
      conversationId: CONVERSATION_ID,
    } as const;
    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug: SLUG,
      name: "Auto Filed",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: {
        elementId: "requirement-1",
        kind: "requirement",
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement",
          statement: "A propose files the asks it leaves pending.",
          priority: "must",
          risk: "high",
        },
      },
      actor,
    });
    specId = created.spec.id;
    revisionId = created.draft.id;
    await authoring.upsertDraftElement({
      specId,
      revisionId: created.draft.id,
      elementId: "criterion-1",
      kind: "criterion",
      parentElementId: "requirement-1",
      position: 1,
      payload: {
        kind: "criterion",
        text: "The propose receipt names the asks it filed.",
        validationStrategy: { kinds: ["test_run"] },
      },
      baseElementVersion: null,
      actor,
    });
  });

  afterEach(() => db.close());

  function openRequests(): SpecNotification[] {
    return notificationsRepo
      .findSpecNotificationsBySpecId(specId)
      .filter((row) => row.type === "spec-approval-requested");
  }

  it("files the current Requirements checkpoint's pending gate and leaves its durable ask behind", async () => {
    const response = await handlers.specActionPOST(
      new Request(
        `http://cc.test/api/projects/${PROJECT_NAME}/specs/${SLUG}/actions/propose`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer valid",
            [SPEC_CALLER_CONVERSATION_HEADER]: CONVERSATION_ID,
          },
          body: JSON.stringify({ revisionId }),
        },
      ),
      {
        params: Promise.resolve({
          name: PROJECT_NAME,
          slug: SLUG,
          action: "propose",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = specProposeResultViewSchema.parse(await response.json());
    expect(
      body.approvalRequests.map(({ gate, outcome }) => [gate, outcome]),
    ).toEqual([["requirements", "filed"]]);

    // The receipt's ids are the durable registry's ids: the Needs You rows a
    // human acts on carry exactly what the agent was told was filed.
    const rows = openRequests();
    expect(rows.map((row) => row.gate).sort()).toEqual(["requirements"]);
    expect(rows.map((row) => row.gateRequestId).sort()).toEqual(
      body.approvalRequests.map((request) => request.attentionId).sort(),
    );
  });
});
