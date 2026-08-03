import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import {
  specEventRowSchema,
  type SpecEventRow,
  type SpecEventType,
} from "@/lib/specs/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { _createTestDb } from "./state-db";
import { stableStringify } from "./serialization";
import {
  createSpecEventsRepo,
  type SpecEventInput,
  type SpecEventsRepo,
} from "./spec-events-repo";

type Db = InstanceType<typeof Database>;

const SPEC_ID = "spec-events-maximal";

let db: Db;
let repo: SpecEventsRepo;

function seedEventParent(): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    "/repos/events-contract",
  );
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SPEC_ID,
    "/repos/events-contract",
    "events-contract",
    "Events contract",
    '{"preset":"contract-bearing"}',
    null,
    null,
    "2026-07-18T08:00:00.000Z",
    "2026-07-18T08:01:00.000Z",
  );
}

function maximalEvent(): SpecEventRow {
  return specEventRowSchema.parse({
    id: 913,
    spec_id: SPEC_ID,
    occurred_at: "2026-07-18T13:00:00.000Z",
    event_type: "spec-review-revision-signed-off",
    actor_json: stableStringify({
      kind: "human",
      accountId: "account-events-maximal",
      displayName: "Alex Reviewer",
    }),
    payload_json: stableStringify({
      revisionId: "revision-events-maximal",
      approvalId: "approval-events-maximal",
      gate: "plan",
      basis: "human_approval",
      affectedElementIds: [
        "requirement-events-maximal",
        "criterion-events-maximal",
      ],
    }),
  });
}

function eventInput(
  eventType: SpecEventType,
  occurredAt: string,
  sequence: number,
): SpecEventInput {
  return {
    spec_id: SPEC_ID,
    occurred_at: occurredAt,
    event_type: eventType,
    actor_json: stableStringify({ kind: "agent", conversationId: "conv-1" }),
    payload_json: stableStringify({ sequence }),
  };
}

function authoringRequest(
  revisionId: string,
  gate: string,
  scope: "gate" | "item",
  subject: string,
  attentionId: string,
): void {
  repo.appendInTransaction({
    spec_id: SPEC_ID,
    occurred_at: "2026-07-18T13:05:00.000Z",
    event_type: "spec-attention-changed",
    actor_json: stableStringify({ kind: "agent", conversationId: "c-1" }),
    payload_json: stableStringify({
      kind: "approval-requested",
      attentionId,
      revisionId,
      gate,
      scope,
      subject,
      executionId: null,
      active: true,
    }),
  });
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  seedEventParent();
  repo = createSpecEventsRepo(db);
});

afterEach(() => {
  db.close();
});

describe("spec-events-repo durability contract", () => {
  it("round-trips every persisted event field with an AUTOINCREMENT id", async () => {
    await assertRoundTripDurability({
      label: "spec-event",
      schema: specEventRowSchema,
      buildMaximalFixture: maximalEvent,
      persist: (fixture) =>
        repo.append({
          spec_id: fixture.spec_id,
          occurred_at: fixture.occurred_at,
          event_type: fixture.event_type,
          actor_json: fixture.actor_json,
          payload_json: fixture.payload_json,
        }),
      reload: (expected) => repo.findEventById(expected.id),
      fieldPolicies: { id: "derived-on-write" },
    });

    const persisted = repo.findBySpecId(SPEC_ID)[0];
    expect(persisted?.id).toBe(1);
    expect(JSON.parse(persisted?.payload_json ?? "null")).toEqual({
      affectedElementIds: [
        "requirement-events-maximal",
        "criterion-events-maximal",
      ],
      approvalId: "approval-events-maximal",
      basis: "human_approval",
      gate: "plan",
      revisionId: "revision-events-maximal",
    });
  });

  it("round-trips durable-only intervention rows through the event-type union", () => {
    const appended = repo.append({
      spec_id: SPEC_ID,
      occurred_at: "2026-07-18T13:05:00.000Z",
      event_type: "spec-intervention-recorded",
      actor_json: stableStringify({ kind: "agent", conversationId: "conv-1" }),
      payload_json: stableStringify({
        kind: "transition-refused",
        surface: "execution_start",
        code: "revision_not_approved",
        unmetConditions: ["The pinned revision is not approved."],
        instruction: "Complete revision sign-off before starting execution.",
      }),
    });

    const reloaded = repo.findEventById(appended.id);
    expect(reloaded?.event_type).toBe("spec-intervention-recorded");
    expect(JSON.parse(reloaded?.payload_json ?? "null")).toMatchObject({
      kind: "transition-refused",
      code: "revision_not_approved",
    });
  });

  it("reads by AUTOINCREMENT id in insertion order, not timestamp order", () => {
    const first = repo.append(
      eventInput("spec-review-commented", "2026-07-18T13:03:00.000Z", 1),
    );
    const second = repo.append(
      eventInput("spec-changed", "2026-07-18T13:01:00.000Z", 2),
    );
    const third = repo.append(
      eventInput("spec-evidence-changed", "2026-07-18T13:02:00.000Z", 3),
    );

    const events = repo.findBySpecId(SPEC_ID);
    expect(events.map((event) => event.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(
      events.map((event) => JSON.parse(event.payload_json).sequence),
    ).toEqual([1, 2, 3]);
    expect(first.id).toBeLessThan(second.id);
    expect(second.id).toBeLessThan(third.id);
  });

  it("finds the active approval request under its logical key, ignoring every other event", () => {
    authoringRequest("revision-1", "requirements", "item", "R1", "attention-1");
    authoringRequest("revision-1", "requirements", "item", "R2", "attention-2");
    authoringRequest("revision-2", "requirements", "item", "R1", "attention-3");
    authoringRequest("revision-1", "design", "item", "D1", "attention-4");
    authoringRequest(
      "revision-1",
      "requirements",
      "gate",
      "requirements",
      "attention-5",
    );
    repo.appendInTransaction(
      eventInput("spec-attention-changed", "2026-07-18T13:06:00.000Z", 9),
    );

    expect(
      repo.findApprovalRequest({
        kind: "authoring",
        specId: SPEC_ID,
        revisionId: "revision-1",
        gate: "requirements",
        scope: "item",
        subject: "R1",
      }),
    ).toEqual({ attentionId: "attention-1" });
    // The gate ask is keyed without a subject: the subjects it is waiting on
    // shrink as approvals land, and its identity must not move with them.
    expect(
      repo.findApprovalRequest({
        kind: "authoring",
        specId: SPEC_ID,
        revisionId: "revision-1",
        gate: "requirements",
        scope: "gate",
        subject: null,
      }),
    ).toEqual({ attentionId: "attention-5" });
    expect(
      repo.findApprovalRequest({
        kind: "authoring",
        specId: SPEC_ID,
        revisionId: "revision-1",
        gate: "plan",
        scope: "gate",
        subject: null,
      }),
    ).toBeNull();
    expect(
      repo.findApprovalRequest({
        kind: "authoring",
        specId: "spec-other",
        revisionId: "revision-1",
        gate: "requirements",
        scope: "item",
        subject: "R1",
      }),
    ).toBeNull();
  });

  it("never reuses a request recorded before requests carried a scope", () => {
    repo.appendInTransaction({
      spec_id: SPEC_ID,
      occurred_at: "2026-07-18T13:05:00.000Z",
      event_type: "spec-attention-changed",
      actor_json: stableStringify({ kind: "agent", conversationId: "c-1" }),
      payload_json: stableStringify({
        kind: "approval-requested",
        attentionId: "attention-pre-boundary",
        revisionId: "revision-1",
        gate: "requirements",
        subject: "R1",
        active: true,
      }),
    });

    for (const scope of ["gate", "item"] as const) {
      expect(
        repo.findApprovalRequest({
          kind: "authoring",
          specId: SPEC_ID,
          revisionId: "revision-1",
          gate: "requirements",
          scope,
          subject: scope === "item" ? "R1" : null,
        }),
      ).toBeNull();
    }
    // It stays readable as an open request until it is retired, which is what
    // lets the review domain close its Needs You entry rather than orphan it.
    expect(repo.listOpenApprovalRequests(SPEC_ID)).toEqual([
      {
        attentionId: "attention-pre-boundary",
        revisionId: "revision-1",
        gate: "requirements",
        scope: null,
        subject: "R1",
        executionId: null,
      },
    ]);
  });

  it("drops a retired request from identity and from the open set, keeping its history", () => {
    authoringRequest(
      "revision-1",
      "requirements",
      "gate",
      "requirements",
      "a1",
    );
    authoringRequest("revision-1", "design", "gate", "design", "a2");
    repo.appendInTransaction({
      spec_id: SPEC_ID,
      occurred_at: "2026-07-18T13:07:00.000Z",
      event_type: "spec-attention-changed",
      actor_json: stableStringify({ kind: "human" }),
      payload_json: stableStringify({
        kind: "approval-request-retired",
        attentionId: "a1",
        reason: "the revision it asked about was withdrawn",
        active: false,
      }),
    });

    expect(
      repo.findApprovalRequest({
        kind: "authoring",
        specId: SPEC_ID,
        revisionId: "revision-1",
        gate: "requirements",
        scope: "gate",
        subject: null,
      }),
    ).toBeNull();
    expect(
      repo.listOpenApprovalRequests(SPEC_ID).map((row) => row.attentionId),
    ).toEqual(["a2"]);
    expect(repo.findBySpecId(SPEC_ID)).toHaveLength(3);
  });

  it("keys a per-run request by its execution, so the next run's ask is a request of its own", () => {
    const request = (executionId: string, attentionId: string) =>
      repo.appendInTransaction({
        spec_id: SPEC_ID,
        occurred_at: "2026-07-18T13:05:00.000Z",
        event_type: "spec-attention-changed",
        actor_json: stableStringify({ kind: "agent", conversationId: "c-1" }),
        payload_json: stableStringify({
          kind: "approval-requested",
          attentionId,
          revisionId: "revision-1",
          gate: "delivery",
          subject: "delivery",
          executionId,
          active: true,
        }),
      });

    request("execution-1", "attention-run-1");
    request("execution-2", "attention-run-2");

    const key = (executionId: string) =>
      ({
        kind: "execution",
        specId: SPEC_ID,
        revisionId: "revision-1",
        gate: "delivery",
        subject: "delivery",
        executionId,
      }) as const;
    expect(repo.findApprovalRequest(key("execution-1"))).toEqual({
      attentionId: "attention-run-1",
    });
    expect(repo.findApprovalRequest(key("execution-2"))).toEqual({
      attentionId: "attention-run-2",
    });
    expect(repo.findApprovalRequest(key("execution-3"))).toBeNull();
    // A per-run ask predates request scope, so the run alone identifies it and
    // an authoring key must never reach it.
    expect(
      repo.findApprovalRequest({
        kind: "authoring",
        specId: SPEC_ID,
        revisionId: "revision-1",
        gate: "delivery",
        scope: "gate",
        subject: null,
      }),
    ).toBeNull();
  });

  it("composes appendInTransaction atomically with a service mutation", () => {
    const transaction = db.transaction((shouldFail: boolean) => {
      db.prepare("UPDATE specs SET name = ? WHERE id = ?").run(
        "Mutated with event",
        SPEC_ID,
      );
      repo.appendInTransaction(
        eventInput("spec-approval-changed", "2026-07-18T13:04:00.000Z", 4),
      );
      if (shouldFail) throw new Error("roll back composed mutation");
    });

    expect(() => transaction(true)).toThrow("roll back composed mutation");
    expect(repo.findBySpecId(SPEC_ID)).toEqual([]);
    expect(
      db.prepare("SELECT name FROM specs WHERE id = ?").get(SPEC_ID),
    ).toEqual({ name: "Events contract" });

    transaction(false);
    expect(repo.findBySpecId(SPEC_ID)).toHaveLength(1);
    expect(
      db.prepare("SELECT name FROM specs WHERE id = ?").get(SPEC_ID),
    ).toEqual({ name: "Mutated with event" });
  });
});
