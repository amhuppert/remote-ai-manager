import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowBoundaryEvent } from "@/lib/workflow-graph/boundary-event-projection";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import type { GraphWorkflowBoundaryKind } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createSubscriptionRuntime } from "./service-factory";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
describe.each(["session", "project"] as const)(
  "finite workflow awareness (%s)",
  (scope) => {
    it("briefs gates during a wait, keeps one terminal delivery, and follows resumed results before explicit rearm", async () => {
      const f = createPersistenceFixture();
      fixture = f;
      const projectPath = "/repo/workflow-waits";
      const sessionName = "work";
      const recipient = { projectPath, conversationId: "origin" };
      const source = { kind: "workflow", id: "workflow" } as const;
      const at = new Date().toISOString();
      f.seedProject(projectPath);
      f.seedSession(projectPath, sessionName);
      const conversation = makeConversationState({
        id: recipient.conversationId,
        scope,
      });
      if (scope === "session")
        await f.seedConversation(projectPath, sessionName, conversation);
      else await f.seedProjectConversation(projectPath, conversation);
      let execution = createWorkflowExecution({
        id: source.id,
        ownerConversationId: recipient.conversationId,
        status: "running",
      });
      f.graphWorkflowExecutions.setActive(
        projectPath,
        sessionName,
        execution,
        at,
      );
      const results = createGraphWorkflowResultDeliveriesRepo(f.db);
      function boundary(
        kind: GraphWorkflowBoundaryKind,
        status: GraphWorkflowExecution["status"],
      ) {
        execution = { ...execution, status };
        f.graphWorkflowExecutions.setActive(
          projectPath,
          sessionName,
          execution,
          at,
        );
        const event = createGraphWorkflowBoundaryEvent({
          projectPath,
          sessionName,
          execution,
          boundaryKind: kind,
        });
        const record = f.graphWorkflowEvents.append(
          projectPath,
          sessionName,
          source.id,
          at,
          { event, occurredAt: at, preReset: false },
        );
        results.record({
          projectPath,
          sessionName,
          executionId: source.id,
          boundarySeq: record.id,
          originConversationId: recipient.conversationId,
          payload: {
            boundaryKind: kind,
            status,
            name: "Delivery",
            pendingActions: event.pendingActions,
            outputs: { boundary: kind },
          },
          recordedAt: at,
          state: "pending",
          attemptId: null,
          attemptCount: 0,
          deliveredAt: null,
          effectsDeliveredAt: at,
        });
        return String(record.id);
      }
      const runtime = createSubscriptionRuntime(f.db, createWriteQueue());
      const input = {
        recipient,
        source,
        reason: "Continue after the terminal result",
      };
      const first = await runtime.activeWaitService.register(input);
      const approval = boundary("context_approval", "running");
      const question = boundary("lane_question", "running");
      const gates = await runtime.service.prepareBriefing({
        recipient,
        attemptId: "gates",
      });
      expect(gates.block).toContain("context_approval");
      expect(gates.block).toContain("lane_question");
      await gates.onInputAccepted();
      const halt = boundary("halt", "halted");
      await runtime.activeWaitService.reconcile(recipient);
      expect(
        (
          await runtime.repo.readInbox(recipient, { includeSettled: true })
        ).items
          .map((row) => row.fact.occurrenceId)
          .sort(),
      ).toEqual([approval, question, halt].sort());
      expect(
        (
          await runtime.service.prepareBriefing({
            recipient,
            attemptId: "before-wake",
          })
        ).block,
      ).toBeNull();
      const batch = await runtime.activeWaitService.prepareBatch(recipient);
      if (!batch) throw Error("Expected terminal wake");
      await runtime.activeWaitService.settleBatch(batch.id, "accepted");
      expect(
        await runtime.repo.get(recipient, first.subscriptionId),
      ).toMatchObject({ mode: "passive", expiresAt: null });
      boundary("completion", "completed");
      const resumed = await runtime.service.prepareBriefing({
        recipient,
        attemptId: "resumed-completion",
      });
      expect(resumed.block).toContain("completion");
      await resumed.onInputAccepted();
      await expect(
        runtime.activeWaitService.register(input),
      ).rejects.toMatchObject({
        code: "ACTIVE_WAIT_SOURCE_FINAL",
        status: 409,
      });
      expect(await runtime.activeWaitService.list(recipient)).toHaveLength(1);
      expect(
        await runtime.activeWaitService.prepareBatch(recipient),
      ).toBeNull();
      const rows = (
        await runtime.repo.readInbox(recipient, { includeSettled: true })
      ).items;
      expect(rows).toHaveLength(4);
      expect(rows.every((row) => row.state === "accepted")).toBe(true);
    });
  },
);
