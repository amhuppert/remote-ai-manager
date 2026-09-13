"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { PublicSessionState } from "@/lib/sessions/schemas";
import { buildSessionContext } from "@/lib/conversations/copy-context";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { useConversationsQuery } from "@/lib/conversations/queries";
import { useSessionQuery } from "@/lib/sessions/queries";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { useGraphWorkflowExecutionQuery } from "@/lib/workflows/queries";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import {
  useCreateConversationMutation,
  useArchiveConversationMutation,
  useRenameConversationMutation,
} from "@/lib/conversations/mutations";
import {
  useDeleteSessionMutation,
  useArchiveSessionMutation,
  useSessionMergeStatusMutation,
} from "@/lib/sessions/mutations";
import {
  useShowArchivedConversations,
  useToggleArchivedConversations,
} from "@/stores/conversations.store";
import { createClientLogger } from "@/lib/logging/client-logger";
import { Button } from "@/components/ui/Button";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { IconButton } from "@/components/ui/IconButton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import {
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  KebabIcon,
  PlusIcon,
  TrashIcon,
  UndoIcon,
} from "@/components/icons";
import NewConversationProfileButton from "@/components/agent-profiles/NewConversationProfileButton";
import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import ConfirmDialog from "@/components/ConfirmDialog";
import SessionTicketIndicator from "@/components/SessionTicketIndicator";
import GraphWorkflowCard from "./GraphWorkflowCard";
import SessionPromotionCandidateCount from "./SessionPromotionCandidateCount";
import SessionOverview, { SessionOverviewPending } from "./SessionOverview";
import SessionWorkspaceTools from "./SessionWorkspaceTools";

const log = createClientLogger("session-overview");
interface Props {
  projectName: string;
  sessionName: string;
}

export default function ConversationList({
  projectName,
  sessionName,
}: Props): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();

  // --- TanStack Query ---
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationsQuery = useConversationsQuery(projectName, sessionName);
  const graphWorkflowExecutionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );

  // --- Zustand ---
  const showArchived = useShowArchivedConversations();
  const toggleArchived = useToggleArchivedConversations();

  // --- Mutations ---
  const deleteMutation = useDeleteSessionMutation(projectName);
  const createConvoMutation = useCreateConversationMutation(
    projectName,
    sessionName,
  );
  const archiveConvoMutation = useArchiveConversationMutation(
    projectName,
    sessionName,
  );
  const renameConvoMutation = useRenameConversationMutation(
    projectName,
    sessionName,
  );
  const archiveSessionMutation = useArchiveSessionMutation(
    projectName,
    sessionName,
  );

  // --- Local UI state ---
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // --- Derived data ---
  const session = sessionQuery.data;
  const mergeStatus = useSessionMergeStatusMutation(projectName, sessionName);

  // --- Copy session context for debugging ---
  const handleCopyContext = useCallback(async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(
        buildSessionContext({
          projectName,
          sessionName,
          session,
          graphWorkflowExecution: graphWorkflowExecutionQuery.data ?? null,
        }),
      );
      setCopyError(null);
      setFeedback("Session context copied");
      log.debug("session_overview.context_copied", {
        projectName,
        sessionName,
      });
    } catch {
      setCopyError("Could not copy session context.");
      log.warn("session_overview.copy_failed", { projectName, sessionName });
    }
  }, [session, projectName, sessionName, graphWorkflowExecutionQuery.data]);

  // Identity is a per-creation choice, so the one-click control (and its
  // hotkey) stays on the Standard Agent the server resolves for an omitted
  // selection, and the picker beside it names one when the user wants one.
  const handleNewConversation = useCallback(
    (profile?: AgentProfileRef) => {
      if (createConvoMutation.isPending || !session) return;
      log.info("session_overview.conversation_create", {
        projectName,
        sessionName,
        profile,
      });
      createConvoMutation.mutate(
        profile === undefined ? undefined : { profile },
        {
          onSuccess: (conversation) =>
            router.push(
              conversationsPageHref({ conversationId: conversation.id }),
            ),
          onError: (error) =>
            log.warn("session_overview.conversation_create_failed", {
              projectName,
              sessionName,
              error: error.message,
            }),
        },
      );
    },
    [createConvoMutation, session, projectName, sessionName, router],
  );
  useAppHotkey("newConversation", () => handleNewConversation(), {
    enabled: !createConvoMutation.isPending && !!session,
  });

  const handleDelete = useCallback(() => {
    if (deleteMutation.isPending) return;
    setShowDeleteConfirm(false);
    log.info("session_overview.session_delete", { projectName, sessionName });
    deleteMutation.mutate(sessionName, {
      onSuccess: () => {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
      onError: (error) => {
        log.warn("session_overview.session_delete_failed", {
          projectName,
          sessionName,
          error: error.message,
        });
      },
    });
  }, [deleteMutation, sessionName, projectName, router]);

  const handleArchive = useCallback(
    (conversationId: string, archived: boolean) => {
      log.info("session_overview.conversation_archive", {
        projectName,
        sessionName,
        conversationId,
        archived,
      });
      archiveConvoMutation.mutate({ conversationId, archived });
    },
    [archiveConvoMutation, projectName, sessionName],
  );

  const handleRename = useCallback(
    (conversationId: string, name: string) => {
      log.info("session_overview.conversation_rename", {
        projectName,
        sessionName,
        conversationId,
      });
      return renameConvoMutation.mutateAsync({ conversationId, name });
    },
    [renameConvoMutation, projectName, sessionName],
  );

  function archiveSession() {
    if (!session || archiveSessionMutation.isPending) return;
    const archived = !session.archived;
    log.info("session_overview.session_archive", {
      projectName,
      sessionName,
      archived,
    });
    archiveSessionMutation.mutate(archived, {
      onSuccess: () => {
        queryClient.setQueryData<PublicSessionState>(
          sessionKeys.detail(projectName, sessionName),
          (current) => (current ? { ...current, archived } : current),
        );
        setFeedback(archived ? "Session archived" : "Session unarchived");
      },
    });
  }

  const mutationError =
    createConvoMutation.error ??
    archiveConvoMutation.error ??
    archiveSessionMutation.error ??
    deleteMutation.error;

  return (
    <div className="app" data-page="conversations">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: projectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
            isProject: true,
          },
          {
            label: sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            isSession: true,
          },
        ]}
      />
      <WorkRailMain
        projectName={projectName}
        sessionName={sessionName}
        contentClassName="overflow-x-hidden overflow-y-auto"
      >
        {session ? (
          <>
            {(mutationError ||
              copyError ||
              feedback ||
              deleteMutation.isPending ||
              archiveSessionMutation.isPending) && (
              <div className="mx-auto max-w-[1440px] px-2xl pt-lg max-768:px-lg">
                {mutationError || copyError ? (
                  <p role="alert" className="text-[0.78rem] text-red-text">
                    {copyError ?? mutationError?.message}
                  </p>
                ) : (
                  <p role="status" className="text-[0.72rem] text-green">
                    {deleteMutation.isPending
                      ? "Deleting session…"
                      : archiveSessionMutation.isPending
                        ? "Updating session archive…"
                        : feedback}
                  </p>
                )}
              </div>
            )}
            <SessionOverview
              projectName={projectName}
              session={session}
              conversations={conversationsQuery.data ?? []}
              showArchived={showArchived}
              onToggleArchived={toggleArchived}
              onArchive={handleArchive}
              onRename={handleRename}
              archivePendingId={
                archiveConvoMutation.isPending
                  ? archiveConvoMutation.variables?.conversationId
                  : undefined
              }
              conversationsLoading={conversationsQuery.isPending}
              conversationError={conversationsQuery.error?.message}
              onRetryConversations={() => void conversationsQuery.refetch()}
              createAction={
                // The one-click control and its profile companion are one
                // affordance; naming the pair is what lets a caller address
                // this header's picker rather than the rail's.
                <div
                  role="group"
                  aria-label="Start a conversation"
                  className="flex items-center gap-2xs"
                >
                  <Button
                    variant="primary"
                    touch
                    onClick={() => handleNewConversation()}
                    loading={createConvoMutation.isPending}
                  >
                    <PlusIcon size={16} />
                    {createConvoMutation.isPending
                      ? "Creating…"
                      : "New conversation"}
                  </Button>
                  <NewConversationProfileButton
                    projectName={projectName}
                    onCreate={handleNewConversation}
                    pending={createConvoMutation.isPending}
                  />
                </div>
              }
              sessionActions={
                <DropdownMenu>
                  <WithTooltip label="Session actions">
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        aria-label="Session actions"
                        disabled={
                          archiveSessionMutation.isPending ||
                          mergeStatus.isPending ||
                          deleteMutation.isPending
                        }
                      >
                        <KebabIcon size={18} />
                      </IconButton>
                    </DropdownMenuTrigger>
                  </WithTooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      touch
                      onSelect={() => void handleCopyContext()}
                    >
                      <CopyIcon size={16} />
                      Copy session context
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      touch
                      onSelect={() => mergeStatus.mutate(!session.finished)}
                    >
                      {session.finished ? (
                        <UndoIcon size={16} />
                      ) : (
                        <CheckIcon size={16} />
                      )}
                      {session.finished ? "Unmark as merged" : "Mark as merged"}
                    </DropdownMenuItem>
                    <DropdownMenuItem touch onSelect={archiveSession}>
                      {session.archived ? (
                        <UndoIcon size={16} />
                      ) : (
                        <ArchiveIcon size={16} />
                      )}
                      {session.archived
                        ? "Unarchive session"
                        : "Archive session"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      touch
                      danger
                      onSelect={() => setShowDeleteConfirm(true)}
                    >
                      <TrashIcon size={16} />
                      Delete session
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
              ticket={
                <SessionTicketIndicator
                  projectName={projectName}
                  sessionName={sessionName}
                />
              }
              workflow={
                graphWorkflowExecutionQuery.isError ? (
                  <p role="alert" className="text-[0.78rem] text-red-text">
                    Could not load workflow.
                    <Button
                      size="sm"
                      onClick={() => void graphWorkflowExecutionQuery.refetch()}
                    >
                      Try again
                    </Button>
                  </p>
                ) : (
                  <GraphWorkflowCard
                    projectName={projectName}
                    sessionName={sessionName}
                    execution={graphWorkflowExecutionQuery.data ?? null}
                  />
                )
              }
              workspaceTools={
                <SessionWorkspaceTools
                  projectName={projectName}
                  session={session}
                />
              }
              finishedNotice={
                // Its durable notes now either move up to the project or die
                // with the session's scope (spec R11); this is the cue that
                // the decision is owed.
                <SessionPromotionCandidateCount
                  projectName={projectName}
                  sessionName={sessionName}
                />
              }
            />
          </>
        ) : (
          <SessionOverviewPending
            sessionName={sessionName}
            error={sessionQuery.error?.message}
            onRetry={() => void sessionQuery.refetch()}
          />
        )}
      </WorkRailMain>
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete session?"
        message={`This will remove the worktree and session state for "${sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
