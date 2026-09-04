import { randomUUID } from "node:crypto";
import { readConfig } from "@/lib/config/loader";
import { publishEvent } from "@/lib/events/publication";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getStateDb, getStateStore } from "@/lib/state-store";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import {
  createMemoryTelemetryRepo,
  type MemoryTelemetryRepo,
} from "@/lib/state-store/memory-telemetry-repo";
import {
  _resetForTesting,
  tryWithWriteQueue,
  withWriteQueue,
  withWriteQueueSync,
} from "@/lib/state-store/write-queue";
import { resolveBoundSpecExecution } from "@/lib/specs/execution-service";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { getTicketsRepo } from "@/lib/tickets/service-factory";
import { findLaneBindingForConversation } from "@/lib/workflow-graph/lane-binding";
import {
  createMemoryContributionGate,
  createMemoryPolicyResolver,
  resolveMemoryIndexBudget,
  type MemoryContributionGate,
  type MemoryPolicyResolver,
} from "./delivery-policy";
import {
  createMemoryFreshnessEngine,
  type MemoryFreshnessEngine,
} from "./freshness";
import {
  createMemoryIndexComposer,
  type MemoryIndexComposer,
} from "./index-composer";
import {
  createMemoryIndexContextProvider,
  type MemoryIndexContextProvider,
} from "./index-live-context";
import { createMemoryRecallService, type MemoryRecallService } from "./recall";
import { createMemoryService, type MemoryService } from "./service";
import {
  createMemoryTelemetryService,
  type MemoryTelemetryService,
} from "./telemetry";
import {
  createMemorySessionLifecycleReader,
  type MemorySessionLifecycleReader,
} from "./session-lifecycle";

/**
 * One repo per process: it shares the module-level write queue so memory
 * writes serialize with every other state-store write, and every surface reuses
 * the same prepared statements.
 */
export function getMemoryRepo(): MemoryRepo {
  return getGlobalSingleton("__cc_memory_repo", () =>
    createMemoryRepo(getStateDb(), {
      withWriteQueue,
      withWriteQueueSync,
      tryWithWriteQueue,
      _resetForTesting,
    }),
  );
}

/**
 * Whether a session incarnation is over (spec R10): the one question memory
 * asks of the session lifecycle. It reads the state store's own accessor, so
 * promotion candidacy sees the same rows the session lifecycle writes rather
 * than a second repository's view of them.
 */
export function getMemorySessionLifecycle(): MemorySessionLifecycleReader {
  return getGlobalSingleton("__cc_memory_session_lifecycle", () =>
    createMemorySessionLifecycleReader({
      async findSession(projectPath, sessionName) {
        return getStateStore().getSession(projectPath, sessionName);
      },
    }),
  );
}

/**
 * The freshness engine (spec R2, R8): the lazy delivery-time check for
 * selected candidates and the full-table review-queue builder. Delivery
 * composers and the review surfaces reach freshness through this, never by
 * comparing leases themselves.
 */
export function getMemoryFreshnessEngine(): MemoryFreshnessEngine {
  return getGlobalSingleton("__cc_memory_freshness_engine", () =>
    createMemoryFreshnessEngine({
      repo: getMemoryRepo(),
      sessions: getMemorySessionLifecycle(),
      now: () => new Date().toISOString(),
    }),
  );
}

/**
 * The delivery policy cascade (spec R10, D7), re-read per resolution: global
 * settings from disk, and for a lane the per-role policy frozen on its
 * execution context at seed time — read off the execution row the lane
 * belongs to, never a saved definition, so a later definition edit cannot
 * change what a running lane reads or may write.
 */
export function getMemoryPolicyResolver(): MemoryPolicyResolver {
  return getGlobalSingleton("__cc_memory_policy_resolver", () =>
    createMemoryPolicyResolver({
      readConfig,
      async findContextPolicy(ref) {
        const execution = await getStateStore().getGraphWorkflowExecutionById(
          ref.projectPath,
          ref.sessionName,
          ref.executionId,
        );
        return (
          execution?.workingDefinition.executionContexts.find(
            (context) => context.id === ref.contextId,
          )?.memory ?? null
        );
      },
    }),
  );
}

/**
 * The contribution gate every memory mutation consults (R10.1). An agent is
 * placed by its conversation id through the state store — session or project
 * conversation — and a lane through the active execution's own bindings, so
 * the policy that governs a write is the one its conversation actually holds.
 */
export function getMemoryContributionGate(): MemoryContributionGate {
  return getGlobalSingleton("__cc_memory_contribution_gate", () =>
    createMemoryContributionGate({
      resolver: getMemoryPolicyResolver(),
      async locateConversation(conversationId) {
        const store = getStateStore();
        const inSession = await store.getConversationById(conversationId);
        if (inSession !== null) {
          return {
            projectPath: inSession.projectPath,
            conversation: {
              kind: "session",
              sessionName: inSession.sessionName,
            },
            role: inSession.conversation.role,
          };
        }
        const inProject =
          await store.getProjectConversationById(conversationId);
        if (inProject !== null) {
          return {
            projectPath: inProject.projectPath,
            conversation: { kind: "project" },
            role: inProject.conversation.role,
          };
        }
        return null;
      },
      async findLaneBinding(ref) {
        const execution = await getStateStore().getActiveGraphWorkflowExecution(
          ref.projectPath,
          ref.sessionName,
        );
        return execution === null
          ? null
          : findLaneBindingForConversation(execution, ref.conversationId);
      },
    }),
  );
}

/**
 * The single owner of memory write decisions. Every memory surface (routes,
 * CLI, the Library, session-end hooks) reaches persistence through this, never
 * through the repo directly, so a refused write can never publish an event and
 * an accepted one can never go unannounced.
 */
export function getMemoryService(): MemoryService {
  return getGlobalSingleton("__cc_memory_service", () =>
    createMemoryService({
      repo: getMemoryRepo(),
      publish: publishEvent,
      contributionGate: getMemoryContributionGate(),
      sessions: getMemorySessionLifecycle(),
      now: () => new Date().toISOString(),
      generateId: () => randomUUID(),
    }),
  );
}

/**
 * The one bounded retrieval verb (spec R7, D5). Every retrieval surface (the
 * cctl recall verb, the route, the index composer's related-artifact reads)
 * goes through this, so ranking, the freshness gate, and the bounded pack are
 * decided once rather than per caller. The lexical provider is the default
 * registration; a semantic ranker joins by being registered beside it.
 */
export function getMemoryRecallService(): MemoryRecallService {
  return getGlobalSingleton("__cc_memory_recall_service", () =>
    createMemoryRecallService({
      repo: getMemoryRepo(),
      freshness: getMemoryFreshnessEngine(),
      now: () => new Date().toISOString(),
    }),
  );
}

/**
 * The `<memory-index>` composer (spec R5, D4): quota-ordered, budgeted, and
 * gated by the freshness engine. The per-turn provider, the `cctl memory
 * index` verb, and the Library's Index Preview all compose through this one
 * instance, which is what makes their output byte-identical (R12.2, R13.1).
 */
export function getMemoryIndexComposer(): MemoryIndexComposer {
  return getGlobalSingleton("__cc_memory_index_composer", () =>
    createMemoryIndexComposer({
      repo: getMemoryRepo(),
      freshness: getMemoryFreshnessEngine(),
      now: () => new Date().toISOString(),
    }),
  );
}

/**
 * One provider per process; re-reads policy, budget, the session incarnation,
 * the linked ticket, and every note row on each turn. Sessions resolve through
 * the state store's own accessor and tickets through the shared tickets
 * repository, so a turn reads the same rows their lifecycles write.
 */
export function getMemoryIndexContextProvider(): MemoryIndexContextProvider {
  return getGlobalSingleton("__cc_memory_index_context_provider", () => {
    const db = getStateDb();
    const bindingRepo = createSpecExecutionBindingRepo(db);
    const deliveryRepo = createSpecDeliveryRepo(db);
    const telemetry = getMemoryTelemetryService();
    return createMemoryIndexContextProvider({
      composer: getMemoryIndexComposer(),
      readIndexDelivery: (conversationId) =>
        telemetry.readIndexDelivery(conversationId),
      resetIndexDelivery: (conversationId) =>
        telemetry.resetIndexDelivery(conversationId),
      now: () => new Date().toISOString(),
      async findSessionCreatedAt(projectPath, sessionName) {
        const session = await getStateStore().getSession(
          projectPath,
          sessionName,
        );
        return session?.createdAt ?? null;
      },
      async findLinkedTicketId(projectPath, sessionName) {
        const ticket = await getTicketsRepo().findLinkedTicket(
          projectPath,
          sessionName,
        );
        return ticket?.id ?? null;
      },
      async findBoundSpecId(workflowExecutionId) {
        // The typed spec↔graph binding is the one authority for "which spec
        // is this run delivering"; the same resolver the spec lifecycle uses.
        const execution = resolveBoundSpecExecution(
          { bindingRepo, deliveryRepo },
          workflowExecutionId,
        );
        return execution?.spec_id ?? null;
      },
      async readBudget() {
        return resolveMemoryIndexBudget(await readConfig());
      },
      async resolveReadPolicy(subject) {
        return (await getMemoryPolicyResolver().resolve(subject)).read.value;
      },
    });
  });
}

/**
 * The observation store (spec R15), on the same connection and write queue as
 * the memory repo so a watermark serializes against the notes it records.
 *
 * Deliberately a repository of its own rather than more methods on
 * `getMemoryRepo()`: the composer and the recall ranker are handed the memory
 * repo, so keeping counters out of it means no selection path has a route to
 * one (`inv-no-popularity-or-telemetry-rank`).
 */
export function getMemoryTelemetryRepo(): MemoryTelemetryRepo {
  return getGlobalSingleton("__cc_memory_telemetry_repo", () =>
    createMemoryTelemetryRepo(getStateDb(), {
      withWriteQueue,
      withWriteQueueSync,
      tryWithWriteQueue,
      _resetForTesting,
    }),
  );
}

/**
 * Delivery watermarks and observation counters (spec R15). Reached by the
 * delivery seams — the turn's index injection, the recall surface, session
 * end, and promotion — never by anything that selects or ranks.
 */
export function getMemoryTelemetryService(): MemoryTelemetryService {
  return getGlobalSingleton("__cc_memory_telemetry_service", () =>
    createMemoryTelemetryService({
      repo: getMemoryTelemetryRepo(),
      now: () => new Date().toISOString(),
    }),
  );
}
