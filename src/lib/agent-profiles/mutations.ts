import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { mutationFetch } from "@/lib/api/fetcher";

import {
  agentProfileDeletionReportSchema,
  agentProfileLibraryItemSchema,
  type AgentProfileContent,
  type AgentProfileDeletionReport,
  type AgentProfileLibraryItem,
  type AgentProfileRef,
  type AgentProfileTier,
  type MutableAgentProfileTier,
} from "./schemas";

/**
 * Authoring writes for the management surface.
 *
 * None of these invalidate: `agent-profile-library-changed` publishes after the
 * commit and `registerAgentProfileSseReactions` already invalidates the owning
 * scope's queries, so a local invalidation here would be a second, racier copy
 * of a rule the event owns — and it would only refresh the tab that happened to
 * make the change.
 *
 * Every write is addressed through the PROJECT route tree. The tier segment is
 * a routing input, so a global-tier record is editable from inside a project;
 * only `create` is scope-bound, because a create lands in the tree's own tier
 * and the global tier therefore has to be addressed by the global route.
 */

function projectBase(projectName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/agent-profiles`;
}

function recordUrl(
  projectName: string,
  ref: AgentProfileRef | { tier: AgentProfileTier; id: string },
): string {
  return `${projectBase(projectName)}/${ref.tier}/${encodeURIComponent(ref.id)}`;
}

export interface CreateAgentProfileVars {
  /** Where the record lands. `global` posts to the project-less route tree. */
  tier: MutableAgentProfileTier;
  id?: string;
  content: AgentProfileContent;
}

export function useCreateAgentProfileMutation(
  projectName: string,
): UseMutationResult<AgentProfileLibraryItem, Error, CreateAgentProfileVars> {
  return useMutation({
    mutationFn: ({ tier, id, content }) =>
      mutationFetch(
        tier === "global" ? "/api/agent-profiles" : projectBase(projectName),
        "create-agent-profile",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(id === undefined ? content : { ...content, id }),
        },
        agentProfileLibraryItemSchema,
      ),
  });
}

export interface UpdateAgentProfileVars {
  ref: AgentProfileRef;
  /** The concurrency token; a stale one answers 409 rather than overwriting. */
  expectedRevision: number;
  content: AgentProfileContent;
}

export function useUpdateAgentProfileMutation(
  projectName: string,
): UseMutationResult<AgentProfileLibraryItem, Error, UpdateAgentProfileVars> {
  return useMutation({
    mutationFn: ({ ref, expectedRevision, content }) =>
      mutationFetch(
        recordUrl(projectName, ref),
        "update-agent-profile",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision, content }),
        },
        agentProfileLibraryItemSchema,
      ),
  });
}

export interface DeleteAgentProfileVars {
  ref: AgentProfileRef;
  expectedRevision: number;
}

export function useDeleteAgentProfileMutation(
  projectName: string,
): UseMutationResult<
  AgentProfileDeletionReport,
  Error,
  DeleteAgentProfileVars
> {
  return useMutation({
    mutationFn: ({ ref, expectedRevision }) =>
      mutationFetch(
        recordUrl(projectName, ref),
        "delete-agent-profile",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // Confirmation is a server-enforced field, not a client convention:
          // the dialog is what makes it true, and a caller that skips the
          // dialog is refused rather than trusted.
          body: JSON.stringify({ expectedRevision, confirm: true }),
        },
        agentProfileDeletionReportSchema,
      ),
  });
}

export interface DuplicateAgentProfileVars {
  source: AgentProfileRef;
  targetTier: MutableAgentProfileTier;
  targetId?: string;
}

export function useDuplicateAgentProfileMutation(
  projectName: string,
): UseMutationResult<
  AgentProfileLibraryItem,
  Error,
  DuplicateAgentProfileVars
> {
  return useMutation({
    mutationFn: ({ source, targetTier, targetId }) =>
      mutationFetch(
        `${projectBase(projectName)}/duplicate`,
        "duplicate-agent-profile",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source,
            targetTier,
            ...(targetId === undefined ? {} : { targetId }),
          }),
        },
        agentProfileLibraryItemSchema,
      ),
  });
}
