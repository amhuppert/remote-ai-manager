import { afterEach, describe, expect, it } from "vitest";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import { createGraphWorkflowBoundaryEvent } from "@/lib/workflow-graph/boundary-event-projection";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createSubscriptionRuntime } from "./service-factory";

const projectPath = "/repo/consolidation";
const sessionName = "session";
const at = "2026-10-01T04:00:00.000Z";
let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

describe.each(["session", "project"] as const)(
  "workflow inbox consolidation (%s)",
  (scope) => {
    it("shares frozen evidence, retains uncertain receipts after restart and avoids a second wake", async () => {
      fixture = createPersistenceFixture();
      fixture.seedProject(projectPath);
      fixture.seedSession(projectPath, sessionName);
      for (const id of ["origin", "peer"]) {
        const conversation = conversationStateSchema.parse({
          id,
          scope,
          status: "idle",
          promptCount: 0,
          createdAt: at,
          lastActivityAt: at,
          transcriptPath: null,
        });
        if (scope === "session")
          await fixture.seedConversation(
            projectPath,
            sessionName,
            conversation,
          );
        else await fixture.seedProjectConversation(projectPath, conversation);
      }
      const origin = { projectPath, conversationId: "origin" };
      const peer = { projectPath, conversationId: "peer" };
      const source = { kind: "workflow", id: "execution" } as const;
      const execution = createWorkflowExecution({
        id: source.id,
        ownerConversationId: origin.conversationId,
        status: "halted",
      });
      fixture.graphWorkflowExecutions.setActive(
        projectPath,
        sessionName,
        execution,
        at,
      );
      const event = createGraphWorkflowBoundaryEvent({
        projectPath,
        sessionName,
        execution,
        boundaryKind: "halt",
      });
      const record = fixture.graphWorkflowEvents.append(
        projectPath,
        sessionName,
        source.id,
        at,
        { event, occurredAt: at, preReset: false },
      );
      const payload = {
        executionId: source.id,
        cursor: record.id,
        name: "Frozen plan",
        boundaryKind: "halt",
        status: "halted",
        outputs: { decision: "Use boundary output" },
        pendingActions: [{ kind: "resume" }],
        haltReason: { type: "manual", reason: "Review original evidence" },
        documents: [{ notepadId: "frozen-reference" }],
      };
      const results = createGraphWorkflowResultDeliveriesRepo(fixture.db);
      results.record({
        executionId: source.id,
        boundarySeq: record.id,
        projectPath,
        sessionName,
        originConversationId: origin.conversationId,
        payload,
        recordedAt: at,
        state: "pending",
        attemptId: null,
        attemptCount: 0,
        deliveredAt: null,
        effectsDeliveredAt: at,
      });
      const build = () => {
        if (!fixture) throw new Error("Missing fixture");
        return createSubscriptionRuntime(fixture.db, createWriteQueue());
      };
      await build().service.autoFollow({
        recipient: peer,
        source,
        reason: "Use shared result",
        initialCursor: "0",
      });
      const first = await build().service.prepareBriefing({
        recipient: origin,
        attemptId: "origin-attempt",
      });
      const second = await build().service.prepareBriefing({
        recipient: peer,
        attemptId: "peer-attempt",
      });
      const originRows = (
        await build().repo.readInbox(origin, { includeSettled: true })
      ).items;
      const peerRows = (
        await build().repo.readInbox(peer, { includeSettled: true })
      ).items;
      expect(originRows).toHaveLength(1);
      expect(peerRows).toHaveLength(1);
      expect(originRows[0]?.fact).toEqual(peerRows[0]?.fact);
      expect(JSON.parse(originRows[0]?.fact.sourceText ?? "null")).toEqual(
        payload,
      );
      expect(first.block).toContain("cctl inbox get");
      expect(second.block).toContain("cctl inbox get");
      await first.onInputAccepted();
      await first.finish();
      await second.finish({ disposition: "uncertain" });
      // New service/repository instances reconstruct all decisions from SQLite.
      expect(
        (
          await build().service.prepareBriefing({
            recipient: origin,
            attemptId: "origin-again",
          })
        ).block,
      ).toBeNull();
      expect(
        (
          await build().service.prepareBriefing({
            recipient: peer,
            attemptId: "peer-again",
          })
        ).block,
      ).toBeNull();
      expect((await build().repo.readInbox(peer, {})).items[0]?.state).toBe(
        "uncertain",
      );
      const wait = await build().activeWaitService.register({
        recipient: origin,
        source,
        reason: "Use terminal boundary",
      });
      expect(wait).toMatchObject({
        state: "settled",
        deliveryId: originRows[0]?.id,
      });
      expect(await build().activeWaitService.prepareBatch(origin)).toBeNull();
      expect(
        (await build().repo.readInbox(origin, { includeSettled: true })).items,
      ).toHaveLength(1);
      expect(
        results.findByBoundary(projectPath, sessionName, source.id, record.id),
      ).toMatchObject({ state: "pending", effectsDeliveredAt: at, payload });
    });
  },
);
