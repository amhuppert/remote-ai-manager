"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@/components/ui/Dialog";
import { FormError, FormLabel } from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import CreateSessionModal from "@/components/session/CreateSessionModal";
import { useSessionsQuery } from "@/lib/sessions/list-queries";
import {
  launchedSpecExecutionReceiptSchema,
  type LaunchedSpecExecutionReceipt,
} from "@/lib/specs/delivery-plan-views";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";

export default function ManagedDeliveryLaunchControl({
  projectName,
  management,
}: {
  projectName: string;
  management: NativeSddWorkflowManagementDetail;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const sessionsQuery = useSessionsQuery(projectName);
  const launch = useSpecActionMutation<
    { revisionId: string; sessionName: string },
    LaunchedSpecExecutionReceipt
  >(
    projectName,
    management.specSlug,
    "start-execution",
    launchedSpecExecutionReceiptSchema,
  );
  const sessions = useMemo(
    () =>
      (sessionsQuery.data ?? []).filter(
        (session) => !session.archived && !session.hasActiveGraphWorkflow,
      ),
    [sessionsQuery.data],
  );

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="primary"
        onClick={() => setOpen(true)}
      >
        Launch
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Launch approved candidate</DialogTitle>
          <p className="font-mono text-[0.72rem] leading-relaxed text-text-secondary">
            Choose the session whose worktree and execution slot will host this
            immutable workflow definition.
          </p>
          <div className="flex flex-col gap-xs">
            <FormLabel htmlFor="managed-delivery-session">
              Session to launch in
            </FormLabel>
            <Select
              value={sessionName ?? ""}
              onValueChange={setSessionName}
              disabled={sessions.length === 0}
            >
              <SelectTrigger
                id="managed-delivery-session"
                aria-label="Session to launch in"
                layoutClassName="w-full"
              >
                <SelectValue placeholder="Select a session" />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem
                    key={session.sessionName}
                    value={session.sessionName}
                    description={session.branchName}
                  >
                    {session.sessionName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sessions.length === 0 && sessionsQuery.isSuccess && (
              <p className="m-0 font-mono text-[0.68rem] text-amber">
                No existing session has a free graph execution slot.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => setCreatingSession(true)}
            >
              Create a session
            </Button>
            {launch.isError && (
              <FormError role="alert">{launch.error.message}</FormError>
            )}
          </div>
          <DialogActions>
            <Button type="button" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              loading={launch.isPending}
              disabled={sessionName === null}
              onClick={() => {
                if (sessionName === null) return;
                const selectedSession = sessionName;
                launch.mutate(
                  {
                    revisionId: management.pinnedRevisionId,
                    sessionName: selectedSession,
                  },
                  {
                    onSuccess: (receipt) => {
                      router.push(
                        `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(selectedSession)}/workflow?execution=${encodeURIComponent(receipt.deliveryPlan.workflowExecutionId)}`,
                      );
                    },
                  },
                );
              }}
            >
              Start execution
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      <CreateSessionModal
        projectName={projectName}
        open={creatingSession}
        onClose={() => setCreatingSession(false)}
        onCreated={(session) => {
          setSessionName(session.sessionName);
          setCreatingSession(false);
        }}
      />
    </>
  );
}
