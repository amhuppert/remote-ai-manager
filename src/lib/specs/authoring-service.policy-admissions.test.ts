import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { deriveNotificationOutcomes } from "@/components/session/sidebar/active-work-adapters";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { createNotificationsService } from "@/lib/notifications/service";
import { createSpecApprovalNotifier } from "@/lib/notifications/spec-approvals";
import type { Notification } from "@/lib/notifications/schemas";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecsRepo, type SpecsRepo } from "@/lib/state-store/specs-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { Db } from "@/lib/state-store/schemas";
import type { SpecGatePolicy } from "@/lib/specs/schemas";

import {
  createAuthoringService,
  type AuthoringService,
} from "./authoring-service";
import { createSpecEventsPublisher } from "./events";

const PROJECT_PATH = "/repos/authoring-policy-admissions";
const PROJECT_NAME = "authoring-policy-admissions-project";
const AGENT = { kind: "agent", conversationId: "conversation-1" } as const;

describe("R11.2 Notify-dial authoring admissions notify the human post hoc (runtime wiring)", () => {
  let db: Db;
  let authoring: AuthoringService;
  let specs: SpecsRepo;
  let reviewRepo: ReturnType<typeof createSpecReviewRepo>;
  let notificationsRepo: ReturnType<typeof createNotificationsRepo>;
  let pushed: Notification[];

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    pushed = [];
    let idSequence = 0;
    let timeSequence = 0;
    const writeQueue = createWriteQueue();
    const eventsRepo = createSpecEventsRepo(db);
    reviewRepo = createSpecReviewRepo(db);
    notificationsRepo = createNotificationsRepo(db);
    const notifications = createNotificationsService({
      repo: () => notificationsRepo,
      publish: () => ({ delivered: true }),
      dispatchPush: (notification) => {
        pushed.push(notification);
      },
    });
    const notifier = createSpecApprovalNotifier({
      createSpecNotification(input) {
        notifications.createSpecNotification(input);
      },
      findSpecNotificationsBySpecId(specId) {
        return notificationsRepo.findSpecNotificationsBySpecId(specId);
      },
      getProjectDisplayName: () => PROJECT_NAME,
    });
    specs = createSpecsRepo(db, writeQueue);
    authoring = createAuthoringService({
      specs,
      review: reviewRepo,
      links: createSpecLinksRepo(db),
      events: createSpecEventsPublisher({
        appendInTransaction: eventsRepo.appendInTransaction,
        publish: () => ({ delivered: true }),
      }),
      waivers: createSpecDeliveryRepo(db),
      policyNotifier: notifier,
      newId(prefix) {
        idSequence += 1;
        return `${prefix}-${idSequence}`;
      },
      now() {
        timeSequence += 1;
        return `2026-07-19T11:00:${String(timeSequence).padStart(2, "0")}.000Z`;
      },
    });
  });

  afterEach(() => db.close());

  async function proposeSpec(slug: string, gatePolicy: SpecGatePolicy) {
    const created = await authoring.createSpec({
      projectPath: PROJECT_PATH,
      slug,
      name: `Authoring admissions ${slug}`,
      gatePolicy: { preset: "fast-path" },
      initialElement: {
        elementId: "requirement-1",
        kind: "requirement" as const,
        parentElementId: null,
        position: 0,
        payload: {
          kind: "requirement" as const,
          statement: "Notify-dial admissions surface post hoc.",
          priority: "must" as const,
          risk: "high" as const,
        },
      },
      actor: AGENT,
    });
    await specs.updateGatePolicy({
      specId: created.spec.id,
      gatePolicy,
      updatedAt: "2026-07-19T11:00:00.500Z",
    });
    for (const element of [
      {
        elementId: "criterion-1",
        kind: "criterion" as const,
        parentElementId: "requirement-1",
        position: 1,
        payload: {
          kind: "criterion" as const,
          text: "A notification row exists per admission.",
          validationStrategy: { kinds: ["test_run" as const] },
        },
      },
      {
        elementId: "task-1",
        kind: "task" as const,
        parentElementId: null,
        position: 2,
        payload: {
          kind: "task" as const,
          title: "Implement the notice",
          instructions: "Implement and test.",
          tracedRequirementElementIds: ["requirement-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-1"],
          dependsOnTaskElementIds: [],
        },
      },
    ]) {
      await authoring.upsertDraftElement({
        specId: created.spec.id,
        revisionId: created.draft.id,
        ...element,
        baseElementVersion: null,
        actor: AGENT,
      });
    }
    const proposed = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    return { created, proposed };
  }

  it("an exploratory propose creates one spec-policy-admitted notification per Notify admission", async () => {
    const { created, proposed } = await proposeSpec("exploratory-notify", {
      preset: "exploratory",
    });
    expect(proposed).toMatchObject({ ok: true, absorbedSignOff: true });

    const admissions = reviewRepo
      .findGateAdmissionsByRevision(created.draft.id)
      .filter((admission) => admission.basis === "notify_policy");
    expect(admissions.map((admission) => admission.gate).sort()).toEqual([
      "plan",
      "requirements",
    ]);

    const rows = notificationsRepo.findSpecNotificationsBySpecId(
      created.spec.id,
    );
    expect(rows).toHaveLength(2);
    expect(
      rows
        .map((row) => ({ type: row.type, gate: row.gate }))
        .sort((a, b) => a.gate.localeCompare(b.gate)),
    ).toEqual([
      { type: "spec-policy-admitted", gate: "plan" },
      { type: "spec-policy-admitted", gate: "requirements" },
    ]);
    // Each notification correlates to its admission row.
    expect(new Set(rows.map((row) => row.gateRequestId))).toEqual(
      new Set(admissions.map((admission) => admission.id)),
    );
    expect(pushed).toHaveLength(2);

    // Post-hoc review notices never open a Needs You item (R11.2).
    const outcomes = deriveNotificationOutcomes(rows, []);
    expect(outcomes.needsAction).toHaveLength(0);
    expect(outcomes.attention).toHaveLength(0);
  });

  it("Off-dial admissions are recorded silently — no notification rows, no pushes", async () => {
    const { created, proposed } = await proposeSpec("all-off", {
      preset: "exploratory",
      overrides: { requirements: "off", design: "off", plan: "off" },
    });
    expect(proposed).toMatchObject({ ok: true });

    const admissions = reviewRepo.findGateAdmissionsByRevision(
      created.draft.id,
    );
    expect(
      admissions.filter((admission) => admission.basis === "off_policy"),
    ).toHaveLength(2);
    expect(
      notificationsRepo.findSpecNotificationsBySpecId(created.spec.id),
    ).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it("a replayed propose keeps one notification per admission", async () => {
    const { created } = await proposeSpec("replayed", {
      preset: "exploratory",
    });

    const replay = await authoring.proposeRevision({
      specId: created.spec.id,
      revisionId: created.draft.id,
      actor: AGENT,
    });
    expect(replay.ok).toBe(false);

    expect(
      notificationsRepo.findSpecNotificationsBySpecId(created.spec.id),
    ).toHaveLength(2);
    expect(pushed).toHaveLength(2);
  });
});
