import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { readConfig } from "@/lib/config/loader";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import {
  createProjectConversationRecord,
  getProjectConversation,
  getProjectConversations,
  mutateProjectConversation,
  setProjectConversationArchived,
  setProjectConversationOpen,
} from "@/lib/state-store";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { buildConversation } from "@/lib/conversations/build-conversation";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import type {
  AgentProfileRef,
  AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import { countOpen } from "./lifecycle";

const logger = createLogger("project-conversations.service");

export interface ProjectConversationServiceDeps {
  createProjectConversationRecord(
    projectPath: string,
    conversation: ConversationState,
  ): Promise<void>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  getProjectConversations(projectPath: string): Promise<ConversationState[]>;
  mutateProjectConversation<T = void>(
    projectPath: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void>;
  setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void>;
  readConfig(): Promise<{ defaultAgentBackend?: AgentBackendId }>;
  getProjectDisplayName(projectPath: string): string;
  newId(): string;
  now(): string;
  /** See the session service's counterpart: resolved before the row exists. */
  resolveProfileSnapshot?(
    projectPath: string,
    ref?: AgentProfileRef | null,
  ): Promise<AgentProfileSnapshot>;
}

export interface CreateProjectConversationOptions {
  agentBackend?: AgentBackendId;
  name?: string;
  /**
   * Token of the create-and-send submission this conversation is created for,
   * recorded on the record so the list the client reads carries the creation's
   * provenance. Absent for every other creation path: those return the
   * conversation to the caller, which already correlates it.
   */
  creationRequestId?: string;
  /** Omitting this yields the explicit Standard Agent snapshot (R7). */
  profile?: AgentProfileRef | null;
}

export interface ProjectConversationService {
  createProjectConversation(
    projectPath: string,
    opts?: CreateProjectConversationOptions,
  ): Promise<ConversationState>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  listProjectConversations(projectPath: string): Promise<ConversationState[]>;
  renameProjectConversation(
    projectPath: string,
    conversationId: string,
    name: string,
  ): Promise<void>;
  setProjectConversationArchived(
    projectPath: string,
    conversationId: string,
    archived: boolean,
  ): Promise<void>;
  setProjectConversationOpen(
    projectPath: string,
    conversationId: string,
    open: boolean,
  ): Promise<void>;
  markProjectConversationRead(
    projectPath: string,
    conversationId: string,
  ): Promise<void>;
  getOpenProjectConversationCount(projectPath: string): Promise<number>;
}

const defaultDeps: ProjectConversationServiceDeps = {
  createProjectConversationRecord,
  getProjectConversation,
  getProjectConversations,
  mutateProjectConversation,
  setProjectConversationArchived,
  setProjectConversationOpen,
  readConfig,
  getProjectDisplayName,
  newId: () => randomUUID(),
  now: () => new Date().toISOString(),
  resolveProfileSnapshot: resolveConversationProfileSnapshot,
};

export function createProjectConversationService(
  deps: ProjectConversationServiceDeps = defaultDeps,
): ProjectConversationService {
  async function createProjectConversation(
    projectPath: string,
    opts?: CreateProjectConversationOptions,
  ): Promise<ConversationState> {
    const existing = await deps.getProjectConversations(projectPath);
    const sequenceNumber = existing.length + 1;
    const projectName = deps.getProjectDisplayName(projectPath);
    const config = await deps.readConfig();
    const agentBackend =
      opts?.agentBackend ?? config.defaultAgentBackend ?? "claude";
    const now = deps.now();
    const resolveProfileSnapshot =
      deps.resolveProfileSnapshot ?? resolveConversationProfileSnapshot;
    const profileSnapshot = await resolveProfileSnapshot(
      projectPath,
      opts?.profile,
    );

    const conversation = buildConversation({
      id: deps.newId(),
      scope: "project",
      name: opts?.name ?? `${projectName} chat ${sequenceNumber}`,
      createdAt: now,
      agentBackend,
      profileSnapshot,
      ...(opts?.creationRequestId !== undefined
        ? { creationRequestId: opts.creationRequestId }
        : {}),
    });
    if (opts?.name !== undefined) {
      // The caller chose this name, so it carries the same protection as a
      // rename; the counter placeholder keeps "default" and stays replaceable.
      conversation.nameOrigin = "manual";
    }

    await deps.createProjectConversationRecord(projectPath, conversation);
    logger.info("project-conversation.created", {
      projectPath,
      conversationId: conversation.id,
      agentBackend,
    });
    return conversation;
  }

  async function renameProjectConversation(
    projectPath: string,
    conversationId: string,
    name: string,
  ): Promise<void> {
    await deps.mutateProjectConversation(
      projectPath,
      conversationId,
      "renameProjectConversation",
      (conversation) => {
        conversation.name = name;
        // A user-chosen name: automatic naming must never overwrite it.
        conversation.nameOrigin = "manual";
      },
    );
  }

  async function markProjectConversationRead(
    projectPath: string,
    conversationId: string,
  ): Promise<void> {
    await deps.mutateProjectConversation(
      projectPath,
      conversationId,
      "markProjectConversationRead",
      (conversation) => {
        conversation.unread = false;
      },
    );
  }

  async function getOpenProjectConversationCount(
    projectPath: string,
  ): Promise<number> {
    const all = await deps.getProjectConversations(projectPath);
    return countOpen(
      all.map((c) => ({ open: c.open ?? false, archived: c.archived })),
    );
  }

  return {
    createProjectConversation,
    getProjectConversation: (projectPath, conversationId) =>
      deps.getProjectConversation(projectPath, conversationId),
    listProjectConversations: (projectPath) =>
      deps.getProjectConversations(projectPath),
    renameProjectConversation,
    setProjectConversationArchived: (projectPath, conversationId, archived) =>
      deps.setProjectConversationArchived(
        projectPath,
        conversationId,
        archived,
      ),
    setProjectConversationOpen: (projectPath, conversationId, open) =>
      deps.setProjectConversationOpen(projectPath, conversationId, open),
    markProjectConversationRead,
    getOpenProjectConversationCount,
  };
}
