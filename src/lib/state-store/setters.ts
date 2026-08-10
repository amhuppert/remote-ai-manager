import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger, type Logger } from "@/lib/logging";
import { timed, timedSync } from "@/lib/logging/timed";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import type { AgentCapabilityOverrides } from "@/lib/agent-capabilities/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { DocumentComment } from "@/lib/document-comments/schemas";
import type { McpOverrides } from "@/lib/mcp/schemas";
import type { SessionMarkdownDocument } from "@/lib/documents/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState, SpawnedFrom } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowEventDelivery,
  GraphWorkflowPushInfo,
} from "@/lib/workflow-graph/execution-events";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

import type { GraphWorkflowArchivedExecutionRow } from "./graph-workflow-archived-executions-repo";
import { jsonOrNull } from "./serialization";
import type { StateStoreCore } from "./schemas";

/**
 * What an explicit archive attempt did. `guard_rejected` carries the execution
 * the guard actually saw, so the caller can report the run that really owns the
 * slot rather than the one it expected.
 */
export type GraphWorkflowArchiveOutcome =
  | { archived: true; execution: GraphWorkflowExecution }
  | { archived: false; reason: "no_active" }
  | {
      archived: false;
      reason: "guard_rejected";
      execution: GraphWorkflowExecution;
    };

const logger = createLogger("state-store");

/**
 * Outcome a focused override-column mutator returns (project / session /
 * conversation `mcp_overrides` or `agent_capability_overrides`). `write: true`
 * persists `overrides` (or clears the column when `undefined`); `write: false`
 * commits nothing — the conflict/skip branch writes no column and touches no
 * timestamp — while still returning `result`. The mutator runs inside the write
 * queue and receives the FRESH persisted overrides, so a caller can fence
 * against a concurrent write or merge onto the latest committed value without
 * any O(total-state) read.
 */
export type FocusedOverridesMutation<TOverrides, TResult> =
  | { write: true; overrides: TOverrides | undefined; result: TResult }
  | { write: false; result: TResult };

/**
 * State-backed ancestor overrides read alongside a session's own
 * `agent_capability_overrides` inside the write queue. The capability effective
 * hash a caller fences against is derived from the whole cascade
 * (global-file → project → session), so a conflict-checked session patch must
 * fence not only its target but the state-backed ancestor (project) too — read
 * atomically here so a parent override that changed since the out-of-queue
 * precondition forces a retry instead of committing a stale hash. The
 * global-file layer is not state-backed and is fenced by the global store's own
 * write lock, so it is intentionally absent.
 */
export interface SessionCapabilityAncestors {
  project: AgentCapabilityOverrides | undefined;
}

/**
 * State-backed ancestor overrides for a session conversation's capability
 * effective hash: project and session (the conversation's own overrides are the
 * target). A conflict-checked conversation patch fences all three.
 */
export interface ConversationCapabilityAncestors {
  project: AgentCapabilityOverrides | undefined;
  session: AgentCapabilityOverrides | undefined;
}

export interface MutationFns {
  mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => T | Promise<T>,
  ): Promise<T>;
}

export function createSetters(
  core: StateStoreCore,
  mutations: MutationFns,
  // Timing logger for the focused capability setters' `state.mutate` wrapper.
  // These setters wrap `timed()` around the queue CALL (not nested inside the
  // callback), so the completion log — a synchronous `appendFileSync` in the
  // production logger — is emitted only after the write queue releases
  // (no-slow-work-in-critical-section). Injectable so the critical-section
  // ordering test can observe the emit lands after `queue:exit`; defaults to the
  // module logger in production.
  storeLogger: Logger = logger,
) {
  const { db, writeQueue, repos } = core;
  const { mutateSession } = mutations;

  /**
   * Focused session creation: insert one session row plus its initial child
   * conversations and reference documents in one transaction, ensuring the FK
   * parent project row exists first. The aggregate is never read, cloned,
   * validated, or diffed, so the write-queue hold is O(1) in total-state. The
   * caller runs the slow provisioning (git worktree add, init script) OUTSIDE
   * this critical section (no-slow-work-in-critical-section); the synchronous
   * callback makes awaiting external work while holding the lock a compile
   * error.
   */
  async function createSessionRow(
    projectPath: string,
    session: SessionState,
  ): Promise<void> {
    return writeQueue.withWriteQueueSync(
      `createSession[${session.sessionName}]`,
      () =>
        timedSync(
          logger,
          "state.mutate",
          {
            label: "createSession",
            projectPath,
            sessionName: session.sessionName,
          },
          () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.sessions.upsert(projectPath, session);
              for (const conversation of session.conversations) {
                repos.conversations.upsert(
                  projectPath,
                  session.sessionName,
                  conversation,
                );
              }
              for (const doc of session.referenceDocuments) {
                repos.referenceDocuments.upsert(
                  projectPath,
                  session.sessionName,
                  doc,
                );
              }
            });
            txn.immediate();
          },
        ),
    );
  }

  /**
   * Focused single-session delete (the provisioning-rollback path). Removes only
   * the target session row; the FK `ON DELETE CASCADE` removes its conversations,
   * graph-workflow execution, and reference documents at the SQL layer. Those
   * cascaded rows never route through the child repos' own `delete`, so their
   * parsed-row caches are invalidated explicitly here (O(1) version bumps).
   * Idempotent — a missing row is a no-op. Synchronous callback.
   */
  async function deleteSessionRow(
    projectPath: string,
    sessionName: string,
    label: string,
  ): Promise<void> {
    return writeQueue.withWriteQueueSync(`${label}[${sessionName}]`, () =>
      timedSync(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        () => {
          repos.sessions.delete(projectPath, sessionName);
          repos.conversations.invalidateCache();
          repos.graphWorkflowExecutions.invalidateCache();
        },
      ),
    );
  }

  /**
   * Focused retarget: point every direct child of `parentSessionName` at `main`
   * and clear its parent link, via a single scoped UPDATE. Synchronous callback.
   */
  async function retargetChildrenToMain(
    projectPath: string,
    parentSessionName: string,
  ): Promise<void> {
    return writeQueue.withWriteQueueSync("retargetChildrenToMain", () =>
      timedSync(
        logger,
        "state.mutate",
        { label: "retargetChildrenToMain", projectPath },
        () => {
          repos.sessions.retargetChildrenOfParents(projectPath, [
            parentSessionName,
          ]);
        },
      ),
    );
  }

  /**
   * Focused fused delete: retarget the children of every deleted parent and
   * delete those sessions in one transaction. The FK `ON DELETE CASCADE` removes
   * each session's conversations, graph-workflow execution, and reference
   * documents at the SQL layer, so a batch delete pays O(1) whole-state cost.
   * Those cascaded rows bypass the child repos' own `delete`, so their
   * parsed-row caches are invalidated explicitly after the commit. Idempotent —
   * names that no longer exist are skipped. Synchronous callback.
   */
  async function applyFusedSessionDelete(
    projectPath: string,
    deletedSessionNames: Iterable<string>,
    label: string,
  ): Promise<void> {
    const names = [...new Set(deletedSessionNames)];
    if (names.length === 0) return;
    return writeQueue.withWriteQueueSync(label, () =>
      timedSync(
        logger,
        "state.mutate",
        { label, projectPath, sessionCount: names.length },
        () => {
          const txn = db.transaction(() => {
            repos.sessions.retargetChildrenOfParents(projectPath, names);
            for (const name of names) {
              repos.sessions.delete(projectPath, name);
            }
          });
          txn.immediate();
          repos.conversations.invalidateCache();
          repos.graphWorkflowExecutions.invalidateCache();
        },
      ),
    );
  }

  /**
   * Focused project delete: remove the project row; the FK `ON DELETE CASCADE`
   * removes its sessions (and their conversations, graph-workflow executions, and
   * reference documents), its project conversations, and every other
   * project-scoped row. Archived/pinned membership is derived from the project
   * row, so it drops automatically. The projects repo holds no parsed-row cache,
   * and the cascaded child rows bypass their repos' own `delete`, so every
   * affected child cache is invalidated explicitly. Synchronous callback.
   */
  async function deleteProjectRow(projectPath: string): Promise<void> {
    return writeQueue.withWriteQueueSync("deleteProject", () =>
      timedSync(
        logger,
        "state.mutate",
        { label: "deleteProject", projectPath },
        () => {
          repos.projects.delete(projectPath);
          repos.sessions.invalidateCache();
          repos.conversations.invalidateCache();
          repos.projectConversations.invalidateCache();
          repos.graphWorkflowExecutions.invalidateCache();
        },
      ),
    );
  }

  /**
   * Focused single-column mutation of a project's `mcp_overrides`. Loads only
   * the target project row inside the write queue, hands the SYNCHRONOUS
   * mutator the currently-persisted overrides, and — when the mutator elects to
   * write — persists the returned overrides (or clears the column) via the
   * repo's focused setter: no aggregate read/clone/validate/diff and no
   * O(total-state) hold. The mutator is synchronous (the sync WriteQueue entry
   * makes awaiting external work while holding the lock a compile error), so
   * callers resolve any discovery/hash I/O BEFORE calling and either compute
   * from the fresh `current` inside the mutator or fence against it.
   */
  async function mutateProjectMcpOverrides<T>(
    projectPath: string,
    label: string,
    mutate: (
      current: McpOverrides | undefined,
    ) => FocusedOverridesMutation<McpOverrides, T>,
  ): Promise<T> {
    // The callback returns the mutation OUTCOME (a plain union, never a
    // Promise), so the sync-queue guard accepts it while `result` still carries
    // the caller's arbitrary `T` back out of the critical section.
    const outcome = await writeQueue.withWriteQueueSync(
      `${label}[${projectPath}]`,
      () =>
        timedSync(logger, "state.mutate", { label, projectPath }, () => {
          const project = repos.projects.findByRootPath(projectPath);
          if (!project) {
            throw new Error(`Project "${projectPath}" not found`);
          }
          const result = mutate(project.mcpOverrides);
          if (result.write) {
            repos.projects.setMcpOverrides(projectPath, result.overrides);
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a project's `agent_capability_overrides`.
   * Same focused-write rationale and synchronous-mutator contract as
   * `mutateProjectMcpOverrides`. The mutator receives the FRESH persisted
   * overrides, so the common no-conflict path can merge concurrent patches
   * atomically and the conflict-detection path can fence against a value that
   * changed since it resolved outside the lock.
   */
  async function mutateProjectAgentCapabilityOverrides<T>(
    projectPath: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback: its completion log is a
    // synchronous `appendFileSync` in the production logger, so nesting it
    // inside the callback would emit it with the write lock held
    // (no-slow-work-in-critical-section). Awaiting the queue defers the emit
    // until after the critical section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath },
      () =>
        writeQueue.withWriteQueueSync(`${label}[${projectPath}]`, () => {
          const project = repos.projects.findByRootPath(projectPath);
          if (!project) {
            throw new Error(`Project "${projectPath}" not found`);
          }
          const result = mutate(project.agentCapabilityOverrides);
          if (result.write) {
            repos.projects.setAgentCapabilityOverrides(
              projectPath,
              result.overrides,
            );
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session's `mcp_overrides`. Loads only
   * the target session row inside the write queue, hands the SYNCHRONOUS mutator
   * the currently-persisted overrides, and — when the mutator writes — updates
   * only the `mcp_overrides` column via the focused per-column setter, leaving
   * every sibling column and `last_activity_at` untouched (an override edit is a
   * config change, not activity). `write: false` (conflict/skip) writes nothing.
   * Callers resolve any discovery/hash I/O BEFORE calling and either compute
   * from the fresh `current` inside the mutator or fence against it.
   */
  async function mutateSessionMcpOverrides<T>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (
      current: McpOverrides | undefined,
    ) => FocusedOverridesMutation<McpOverrides, T>,
  ): Promise<T> {
    const outcome = await writeQueue.withWriteQueueSync(
      `${label}[${sessionName}]`,
      () =>
        timedSync(
          logger,
          "state.mutate",
          { label, projectPath, sessionName },
          () => {
            const session = repos.sessions.findByKey(projectPath, sessionName);
            if (!session) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}"`,
              );
            }
            const result = mutate(session.mcpOverrides);
            if (result.write) {
              repos.sessions.updateChangedColumns(projectPath, sessionName, {
                mcp_overrides: jsonOrNull(result.overrides),
              });
            }
            return result;
          },
        ),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a conversation's `mcp_overrides`. Loads
   * only the target conversation row inside the write queue, hands the
   * SYNCHRONOUS mutator the currently-persisted overrides, and — when the mutator
   * writes — updates only the `mcp_overrides` column via the no-touch per-column
   * setter, leaving every sibling column, the conversation's own
   * `last_activity_at`, and the owning session's activity untouched (an override
   * edit is a config change, not activity, and must not reorder conversations).
   * `write: false` (conflict/skip) writes nothing. Callers resolve any
   * discovery/hash I/O BEFORE calling and either compute from the fresh
   * `current` inside the mutator or fence against it.
   */
  async function mutateConversationMcpOverrides<T>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (
      current: McpOverrides | undefined,
    ) => FocusedOverridesMutation<McpOverrides, T>,
  ): Promise<T> {
    const outcome = await writeQueue.withWriteQueueSync(
      `${label}[${sessionName}]`,
      () =>
        timedSync(
          logger,
          "state.mutate",
          { label, projectPath, sessionName, conversationId },
          () => {
            const conversation = repos.conversations.findByKey(
              projectPath,
              sessionName,
              conversationId,
            );
            if (!conversation) {
              throw new Error(
                `Conversation "${conversationId}" not found in session "${sessionName}"`,
              );
            }
            const result = mutate(conversation.mcpOverrides);
            if (result.write) {
              repos.conversations.updateChangedColumns(
                projectPath,
                sessionName,
                conversationId,
                { mcp_overrides: jsonOrNull(result.overrides) },
              );
            }
            return result;
          },
        ),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session's `agent_capability_overrides`.
   * The synchronous mutator receives the FRESH persisted target overrides plus
   * the state-backed ancestor (project) overrides — both read atomically inside
   * the write queue — so a conflict-checked caller can fence the target AND the
   * ancestor the effective hash depends on. `write: true` persists only the
   * `agent_capability_overrides` column (siblings and `last_activity_at`
   * untouched — an override edit is config, not activity); `write: false`
   * (conflict/skip) writes nothing, so a raced conflict cannot restamp activity.
   * Callers resolve the expected-hash precondition BEFORE calling (its discovery
   * + whole-chain I/O must not run in the critical section).
   */
  async function mutateSessionAgentCapabilityOverrides<T>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
      ancestors: SessionCapabilityAncestors,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback (see
    // `mutateProjectAgentCapabilityOverrides`): the completion log is a
    // synchronous `appendFileSync` and must fire after the section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath, sessionName },
      () =>
        writeQueue.withWriteQueueSync(`${label}[${sessionName}]`, () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}"`,
            );
          }
          const project = repos.projects.findByRootPath(projectPath);
          const result = mutate(session.agentCapabilityOverrides, {
            project: project?.agentCapabilityOverrides,
          });
          if (result.write) {
            repos.sessions.updateChangedColumns(projectPath, sessionName, {
              agent_capability_overrides: jsonOrNull(result.overrides),
            });
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session conversation's
   * `agent_capability_overrides`. Same contract as
   * `mutateSessionAgentCapabilityOverrides`, with the conversation as target and
   * project + session read as the state-backed ancestors the effective hash
   * depends on. Writes only the `agent_capability_overrides` column via the
   * no-touch per-column setter, so neither the conversation's own
   * `last_activity_at` nor the owning session's activity moves.
   */
  async function mutateConversationAgentCapabilityOverrides<T>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
      ancestors: ConversationCapabilityAncestors,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback (see
    // `mutateProjectAgentCapabilityOverrides`): the completion log is a
    // synchronous `appendFileSync` and must fire after the section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath, sessionName, conversationId },
      () =>
        writeQueue.withWriteQueueSync(`${label}[${sessionName}]`, () => {
          const conversation = repos.conversations.findByKey(
            projectPath,
            sessionName,
            conversationId,
          );
          if (!conversation) {
            throw new Error(
              `Conversation "${conversationId}" not found in session "${sessionName}"`,
            );
          }
          const session = repos.sessions.findByKey(projectPath, sessionName);
          const project = repos.projects.findByRootPath(projectPath);
          const result = mutate(conversation.agentCapabilityOverrides, {
            project: project?.agentCapabilityOverrides,
            session: session?.agentCapabilityOverrides,
          });
          if (result.write) {
            repos.conversations.updateChangedColumns(
              projectPath,
              sessionName,
              conversationId,
              { agent_capability_overrides: jsonOrNull(result.overrides) },
            );
          }
          return result;
        }),
    );
    return outcome.result;
  }

  /**
   * Focused single-column mutation of a session-less project conversation's
   * `agent_capability_overrides`. The project-conversation cascade skips the
   * session layer, so only the project ancestor is fenced. Writes only the
   * `agent_capability_overrides` column via the project-conversation repo's
   * no-touch focused setter, so the PLC's `last_activity_at` is never restamped
   * by a config edit.
   */
  async function mutateProjectConversationAgentCapabilityOverrides<T>(
    projectPath: string,
    conversationId: string,
    label: string,
    mutate: (
      current: AgentCapabilityOverrides | undefined,
      ancestors: SessionCapabilityAncestors,
    ) => FocusedOverridesMutation<AgentCapabilityOverrides, T>,
  ): Promise<T> {
    // `timed` wraps the queue CALL, not the callback (see
    // `mutateProjectAgentCapabilityOverrides`): the completion log is a
    // synchronous `appendFileSync` and must fire after the section releases.
    const outcome = await timed(
      storeLogger,
      "state.mutate",
      { label, projectPath, conversationId },
      () =>
        writeQueue.withWriteQueueSync(
          `${label}[project::${conversationId}]`,
          () => {
            const conversation = repos.projectConversations.findByKey(
              projectPath,
              conversationId,
            );
            if (!conversation) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
            const project = repos.projects.findByRootPath(projectPath);
            const result = mutate(conversation.agentCapabilityOverrides, {
              project: project?.agentCapabilityOverrides,
            });
            if (result.write) {
              repos.projectConversations.setAgentCapabilityOverrides(
                projectPath,
                conversationId,
                result.overrides,
              );
            }
            return result;
          },
        ),
    );
    return outcome.result;
  }

  async function setSessionArchived(
    projectPath: string,
    sessionName: string,
    archived: boolean,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionArchived",
      (session) => {
        session.archived = archived;
      },
    );
  }

  async function setSessionTddEnabled(
    projectPath: string,
    sessionName: string,
    tddEnabled: boolean,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionTddEnabled",
      (session) => {
        session.tddEnabled = tddEnabled;
      },
    );
  }

  async function setSessionFinished(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    await mutateSession(
      projectPath,
      sessionName,
      "setSessionFinished",
      (session) => {
        session.finished = true;
        session.archived = true;
      },
    );
  }

  async function setConversationPendingPromptText(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    if (isProjectSentinel(sessionName)) {
      return setProjectConversationPendingPromptText(
        projectPath,
        conversationId,
        text,
      );
    }
    return writeQueue.withWriteQueue(
      `setConversationPendingPromptText[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setConversationPendingPromptText",
            projectPath,
            sessionName,
            conversationId,
          },
          async () => {
            const updated = repos.conversations.setPendingPromptText(
              projectPath,
              sessionName,
              conversationId,
              text,
            );
            if (!updated) {
              throw new Error(
                `Conversation "${conversationId}" not found in session "${sessionName}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectConversationPendingPromptText(
    projectPath: string,
    conversationId: string,
    text: string | null,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationPendingPromptText[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationPendingPromptText",
            projectPath,
            conversationId,
          },
          async () => {
            const updated = repos.projectConversations.setPendingPromptText(
              projectPath,
              conversationId,
              text,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function createProjectConversation(
    projectPath: string,
    conversation: ConversationState,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `createProjectConversation[${conversation.id}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "createProjectConversation",
            projectPath,
            conversationId: conversation.id,
          },
          async () => {
            // project_conversations has an FK to projects(root_path). A freshly
            // configured repo with no prior session/pin/archive state has no
            // projects row yet, so ensure one exists before the insert.
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projectConversations.upsert(projectPath, conversation);
            });
            txn.immediate();
          },
        ),
    );
  }

  async function setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationArchived[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationArchived",
            projectPath,
            conversationId,
            archived,
          },
          async () => {
            const updated = repos.projectConversations.setArchived(
              projectPath,
              conversationId,
              archived,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectConversationOpen[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "setProjectConversationOpen",
            projectPath,
            conversationId,
            open,
          },
          async () => {
            const updated = repos.projectConversations.setOpen(
              projectPath,
              conversationId,
              open,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  async function setProjectArchived(
    projectPath: string,
    archived: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectArchived[${projectPath}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setProjectArchived", projectPath, archived },
          async () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projects.setArchived(projectPath, archived);
            });
            txn.immediate();
          },
        ),
    );
  }

  async function setProjectPinned(
    projectPath: string,
    pinned: boolean,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setProjectPinned[${projectPath}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setProjectPinned", projectPath, pinned },
          async () => {
            const txn = db.transaction(() => {
              if (!repos.projects.findByRootPath(projectPath)) {
                repos.projects.upsert({ rootPath: projectPath });
              }
              repos.projects.setPinned(projectPath, pinned);
            });
            txn.immediate();
          },
        ),
    );
  }

  /**
   * Tag a session with its `from chat` origin. One-time focused single-column
   * write at chat-spawn creation (Pattern 2: no whole-state read / no
   * per-keystroke mutate*).
   */
  async function setSessionSpawnedFrom(
    projectPath: string,
    sessionName: string,
    spawnedFrom: SpawnedFrom,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `setSessionSpawnedFrom[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "setSessionSpawnedFrom", projectPath, sessionName },
          async () => {
            const updated = repos.sessions.setSpawnedFrom(
              projectPath,
              sessionName,
              spawnedFrom,
            );
            if (!updated) {
              throw new Error(
                `Session "${sessionName}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  /**
   * Append spawned session names to a project conversation's back-link. Batched
   * single-row append performed once after the spawn-create loop (Pattern 2).
   */
  async function addPlcSpawnedSessionIds(
    projectPath: string,
    conversationId: string,
    sessionNames: string[],
  ): Promise<void> {
    if (sessionNames.length === 0) return;
    return writeQueue.withWriteQueue(
      `addPlcSpawnedSessionIds[${conversationId}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          { label: "addPlcSpawnedSessionIds", projectPath, conversationId },
          async () => {
            const updated = repos.projectConversations.appendSpawnedSessionIds(
              projectPath,
              conversationId,
              sessionNames,
            );
            if (!updated) {
              throw new Error(
                `Project conversation "${conversationId}" not found in project "${projectPath}"`,
              );
            }
          },
        ),
    );
  }

  /**
   * Atomically write the active graph-workflow execution blob (history-free)
   * and append its computed append-only event rows to `graph_workflow_events`,
   * inside a single write-queue critical section. The mutator receives the
   * currently-persisted execution and returns the next execution, the event rows
   * to append, and optional pure push descriptors — inert DATA, never a
   * callable, so the reducer cannot broadcast.
   *
   * This seam performs NO external delivery and NO logging inside the critical
   * section: the queue callback is limited to repo writes and pure computation
   * (`no-slow-work-in-critical-section`). It returns the committed execution and
   * the delivery DATA (rows whose inner SSE events must be broadcast + the push
   * descriptors); the graph-workflow repository — which owns the broadcaster and
   * push dispatcher — performs delivery only AFTER this resolves, i.e. after
   * `txn.immediate()` has committed (Design 3.2, `post-commit-delivery`). A
   * thrown commit rejects here with nothing delivered, so a mutation that did
   * not persist can never have told a client it did. The `state.mutate` timing
   * is measured with a pure clock read inside the lock but emitted afterward.
   */
  async function mutateActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (current: GraphWorkflowExecution | null) => {
      execution: GraphWorkflowExecution;
      events: GraphWorkflowExecutionEvent[];
      pushes?: GraphWorkflowPushInfo[];
    },
  ): Promise<{
    execution: GraphWorkflowExecution;
    delivery: GraphWorkflowEventDelivery;
  }> {
    let committed:
      | {
          execution: GraphWorkflowExecution;
          delivery: GraphWorkflowEventDelivery;
        }
      | undefined;
    let holdMs = 0;
    try {
      committed = await writeQueue.withWriteQueueSync(
        `${label}[${sessionName}]`,
        () => {
          const startedAt = Date.now();
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const { execution, events, pushes } = mutate(
            repos.graphWorkflowExecutions.getActive(projectPath, sessionName),
          );
          const now = new Date().toISOString();
          const txn = db.transaction(() => {
            repos.graphWorkflowExecutions.setActive(
              projectPath,
              sessionName,
              execution,
              now,
            );
            repos.graphWorkflowEvents.appendMany(
              projectPath,
              sessionName,
              execution.id,
              now,
              events,
            );
          });
          txn.immediate();
          holdMs = Date.now() - startedAt;
          return { execution, delivery: { events, pushes: pushes ?? [] } };
        },
      );
    } catch (err) {
      logger.warn("state.mutate.error", {
        label,
        projectPath,
        sessionName,
        error: err instanceof Error ? err : String(err),
      });
      throw err;
    }
    // Emitted post-critical-section so the queue callback itself does no I/O.
    logger.info("state.mutate.complete", {
      label,
      projectPath,
      sessionName,
      durationMs: holdMs,
    });
    return committed;
  }

  /**
   * Move the active graph-workflow execution into the archived-executions table
   * (control-state only; its events stay in `graph_workflow_events` keyed by the
   * same execution id) and null the active blob, inside one write-queue section.
   */
  /**
   * `audit` records the explicit archive act. It is appended inside the SAME
   * transaction that moves the execution out of the active slot: releasing IS
   * the state change, so a release whose audit row could be lost separately
   * would leave no durable answer to "who released this session's run".
   */
  async function archiveActiveGraphWorkflowExecution(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
  ): Promise<GraphWorkflowArchiveOutcome> {
    return writeQueue.withWriteQueue(
      `archiveGraphWorkflowExecution[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "archiveGraphWorkflowExecution",
            projectPath,
            sessionName,
          },
          async () => {
            const execution = repos.graphWorkflowExecutions.getActive(
              projectPath,
              sessionName,
            );
            if (!execution) return { archived: false, reason: "no_active" };
            // The caller's expected-id and lifecycle-eligibility test is
            // re-applied HERE, inside the queue's critical section, against the
            // row as it is right now. Checking before acquiring the queue is a
            // TOCTOU: a concurrent resume can turn an eligible `paused` run
            // into `running`, and a concurrent start can install a different
            // execution, either of which the stale decision would then archive.
            // The guard is pure by contract, so it is legal in here.
            if (guard !== undefined && !guard(execution)) {
              return { archived: false, reason: "guard_rejected", execution };
            }
            const now = new Date().toISOString();
            const row: GraphWorkflowArchivedExecutionRow = {
              projectPath,
              sessionName,
              executionId: execution.id,
              archivedAt: now,
              status: execution.status,
              startedAt: execution.startedAt,
              completedAt: execution.completedAt,
              execution,
            };
            const txn = db.transaction(() => {
              if (audit !== undefined) {
                repos.graphWorkflowEvents.appendMany(
                  projectPath,
                  sessionName,
                  execution.id,
                  now,
                  [
                    {
                      occurredAt: now,
                      preReset: false,
                      event: {
                        type: "graph-workflow-execution-released",
                        projectName: path.basename(projectPath),
                        sessionName,
                        executionId: execution.id,
                        status: execution.status,
                        reason: audit.reason,
                        actor: audit.actor,
                      },
                    },
                  ],
                );
              }
              repos.graphWorkflowArchivedExecutions.insert(row);
              repos.graphWorkflowExecutions.setActive(
                projectPath,
                sessionName,
                null,
                now,
              );
            });
            txn.immediate();
            return { archived: true, execution };
          },
        ),
    );
  }

  /**
   * Mark every persisted event for a context up to the current insertion
   * boundary as pre-reset, replacing the old in-memory `history.map` reset
   * marking. Returns the number of rows newly marked.
   */
  async function markGraphWorkflowContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number> {
    return writeQueue.withWriteQueue(
      `markGraphWorkflowContextEventsPreReset[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "markGraphWorkflowContextEventsPreReset",
            projectPath,
            sessionName,
            conversationId: undefined,
          },
          async () => {
            const boundaryRow = db
              .prepare(
                `SELECT MAX(id) AS maxId FROM graph_workflow_events
                  WHERE execution_id = ?`,
              )
              .get(executionId) as { maxId: number | null };
            const boundaryId = boundaryRow.maxId;
            if (boundaryId === null) return 0;
            return repos.graphWorkflowEvents.markPreReset(
              executionId,
              contextId,
              boundaryId,
            );
          },
        ),
    );
  }

  /**
   * Focused single-column write of the session's `workflow_lanes` map. Loads
   * only the target session, hands the mutator the existing lane map (mutated
   * in place), and persists via the repo's focused setter — skipping the
   * whole-state read / clone / Zod-validate / sibling-canonicalize cycle that
   * `mutateSession` runs and the full-row re-serialization of every other
   * session column (including the large `graph_workflow_execution` blob). Stays
   * inside the write queue so concurrent same-session writes serialize.
   */
  async function mutateSessionWorkflowLanes<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (lanes: Record<string, unknown>) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const lanes = session.workflowLanes ?? {};
          const result = await mutate(lanes);
          repos.sessions.setSessionWorkflowLanes(
            projectPath,
            sessionName,
            lanes,
            new Date().toISOString(),
          );
          return result;
        },
      ),
    );
  }

  /**
   * Focused single-column write of the session's `workflow_envelopes` map.
   * Same focused-write rationale as `mutateSessionWorkflowLanes`.
   */
  async function mutateSessionWorkflowEnvelopes<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (envelopes: Record<string, unknown>) => T | Promise<T>,
  ): Promise<T> {
    return writeQueue.withWriteQueue(`${label}[${sessionName}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label, projectPath, sessionName },
        async () => {
          const session = repos.sessions.findByKey(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" not found in project "${projectPath}" during ${label}`,
            );
          }
          const envelopes = session.workflowEnvelopes ?? {};
          const result = await mutate(envelopes);
          repos.sessions.setSessionWorkflowEnvelopes(
            projectPath,
            sessionName,
            envelopes,
            new Date().toISOString(),
          );
          return result;
        },
      ),
    );
  }

  async function createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<ReferenceDocument> {
    return mutateSession<ReferenceDocument>(
      projectPath,
      sessionName,
      "createReferenceDocument",
      (session) => {
        const existing = session.referenceDocuments.find(
          (d) => d.filePath === filePath,
        );
        if (existing) {
          existing.description = description;
          // Return a plain snapshot, not the draft element: the focused mutate
          // path finalizes the draft after the mutator returns, revoking every
          // draft proxy — including this one — so returning it directly would
          // throw on first access by the caller.
          return {
            id: existing.id,
            filePath: existing.filePath,
            description: existing.description,
            createdAt: existing.createdAt,
          };
        }
        const doc: ReferenceDocument = {
          id: randomUUID(),
          filePath,
          description,
          createdAt: new Date().toISOString(),
        };
        session.referenceDocuments.push(doc);
        return doc;
      },
    );
  }

  async function deleteReferenceDocument(
    projectPath: string,
    sessionName: string,
    documentId: string,
  ): Promise<ReferenceDocument | null> {
    return mutateSession<ReferenceDocument | null>(
      projectPath,
      sessionName,
      "deleteReferenceDocument",
      (session) => {
        const index = session.referenceDocuments.findIndex(
          (d) => d.id === documentId,
        );
        if (index === -1) return null;
        const removed = session.referenceDocuments[index]!;
        // Snapshot into a plain object before splicing: the focused mutate path
        // runs the mutator against an Immer draft, and a spliced-off element is
        // not part of the finalized `next`, so its proxy is revoked when the
        // draft finishes — returning it directly would throw on first access.
        const snapshot: ReferenceDocument = {
          id: removed.id,
          filePath: removed.filePath,
          description: removed.description,
          createdAt: removed.createdAt,
        };
        session.referenceDocuments.splice(index, 1);
        return snapshot;
      },
    );
  }

  async function upsertSessionMarkdownDocuments(
    projectPath: string,
    sessionName: string,
    documents: readonly SessionMarkdownDocument[],
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `upsertSessionMarkdownDocuments[${sessionName}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "upsertSessionMarkdownDocuments",
            projectPath,
            sessionName,
            documentCount: documents.length,
          },
          async () => {
            repos.sessionMarkdownDocuments.upsertMany(
              projectPath,
              sessionName,
              documents,
            );
          },
        ),
    );
  }

  /** Upsert a document comment through the serialized write queue. */
  async function upsertDocumentComment(
    comment: DocumentComment,
  ): Promise<void> {
    return writeQueue.withWriteQueue(
      `upsertDocumentComment[${comment.id}]`,
      async () =>
        timed(
          logger,
          "state.mutate",
          {
            label: "upsertDocumentComment",
            projectPath: comment.projectPath,
            sessionName: comment.sessionName,
          },
          async () => {
            repos.documentComments.upsert(comment);
          },
        ),
    );
  }

  async function deleteDocumentComment(id: string): Promise<void> {
    return writeQueue.withWriteQueue(`deleteDocumentComment[${id}]`, async () =>
      timed(
        logger,
        "state.mutate",
        { label: "deleteDocumentComment", id },
        async () => {
          repos.documentComments.delete(id);
        },
      ),
    );
  }

  return {
    createSessionRow,
    deleteSessionRow,
    retargetChildrenToMain,
    applyFusedSessionDelete,
    deleteProjectRow,
    mutateProjectMcpOverrides,
    mutateProjectAgentCapabilityOverrides,
    mutateSessionMcpOverrides,
    mutateConversationMcpOverrides,
    mutateSessionAgentCapabilityOverrides,
    mutateConversationAgentCapabilityOverrides,
    mutateProjectConversationAgentCapabilityOverrides,
    setSessionArchived,
    setSessionTddEnabled,
    setSessionFinished,
    setConversationPendingPromptText,
    createProjectConversation,
    setProjectConversationPendingPromptText,
    setProjectConversationArchived,
    setProjectConversationOpen,
    setProjectArchived,
    setProjectPinned,
    setSessionSpawnedFrom,
    addPlcSpawnedSessionIds,
    mutateActiveGraphWorkflowExecution,
    archiveActiveGraphWorkflowExecution,
    markGraphWorkflowContextEventsPreReset,
    mutateSessionWorkflowLanes,
    mutateSessionWorkflowEnvelopes,
    createReferenceDocument,
    deleteReferenceDocument,
    upsertSessionMarkdownDocuments,
    upsertDocumentComment,
    deleteDocumentComment,
  };
}
