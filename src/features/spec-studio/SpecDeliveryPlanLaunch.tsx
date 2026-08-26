"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { FormError, FormLabel } from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { useSessionsQuery } from "@/lib/sessions/list-queries";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import {
  launchedSpecExecutionReceiptSchema,
  type LaunchedSpecExecutionReceipt,
} from "@/lib/specs/delivery-plan-views";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";

/**
 * The launch act, in the one place a human already stands when sign-off is
 * done. It launches the candidate the attempt carries — the same bytes
 * sign-off bound — so nothing here re-decides what runs; the only open
 * question is WHERE, and the server refuses a launch that names no session
 * (`spec start` is session-only: the run takes that session's worktree,
 * branch, and its one execution slot).
 */

/**
 * A session that can host this launch. A session already holding a graph
 * execution has no free slot, so offering it would only buy a server refusal
 * after a click that reads as irreversible.
 */
function launchableSessions(
  sessions: readonly SessionListItem[],
): readonly SessionListItem[] {
  return sessions.filter(
    (session) =>
      !session.archived && !session.finished && !session.hasActiveGraphWorkflow,
  );
}

/**
 * The gate, kept outside the control so an unsigned plan reads no sessions.
 * Sign-off binds one candidate hash: an attempt whose frozen candidate moved
 * past its approval is not launchable here — the sign-off panel next door owns
 * re-approving it.
 */
export default function SpecDeliveryPlanLaunch({
  projectName,
  review,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
}): React.JSX.Element | null {
  const { attempt, approval } = review;
  if (approval === null) return null;
  if (attempt.candidateHash === null) return null;
  if (approval.candidateHash !== attempt.candidateHash) return null;
  if (attempt.status !== "approved" && attempt.status !== "parked") return null;
  return (
    <LaunchControl
      projectName={projectName}
      review={review}
      approval={approval}
    />
  );
}

function LaunchControl({
  projectName,
  review,
  approval,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
  approval: NonNullable<DeliveryPlanReviewView["approval"]>;
}): React.JSX.Element {
  const { attempt } = review;
  const slug = attempt.specSlug;
  const queryClient = useQueryClient();
  const [sessionName, setSessionName] = useState<string | null>(null);
  const sessionsQuery = useSessionsQuery(projectName);
  const launch = useSpecActionMutation<
    { revisionId: string; sessionName: string },
    LaunchedSpecExecutionReceipt
  >(projectName, slug, "start-execution", launchedSpecExecutionReceiptSchema);

  const sessions = launchableSessions(sessionsQuery.data ?? []);
  const receipt = launch.data ?? null;

  return (
    <section
      id="delivery-plan-launch"
      tabIndex={-1}
      aria-label="Plan launch"
      className="rounded-md border border-solid border-green-dim bg-green-glow p-md"
    >
      <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Launch approved candidate
      </h4>
      <p className="mt-0 mb-sm font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        Starts candidate <code>{approval.candidateId}</code> exactly as signed
        off. The run takes the session&apos;s worktree and its one execution
        slot.
      </p>

      {receipt === null && (
        <div className="flex flex-col gap-xs">
          <FormLabel htmlFor="delivery-plan-launch-session">
            Session to launch in
          </FormLabel>
          <Select
            value={sessionName ?? undefined}
            onValueChange={setSessionName}
            disabled={sessions.length === 0}
          >
            <SelectTrigger
              id="delivery-plan-launch-session"
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
          {sessionsQuery.isError && (
            <p className="m-0 font-mono text-[0.68rem] leading-relaxed text-amber">
              The project&apos;s sessions could not be read, so there is nothing
              to launch into yet. Nothing was started.
            </p>
          )}
          {sessionsQuery.isSuccess && sessions.length === 0 && (
            <p className="m-0 font-mono text-[0.68rem] leading-relaxed text-amber">
              No session in this project is free to host a launch. Create one,
              or finish the graph execution holding the slot.
            </p>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={launch.isPending}
            disabled={sessionName === null}
            onClick={() => {
              if (sessionName === null) return;
              launch.mutate(
                { revisionId: attempt.pinnedRevisionId, sessionName },
                {
                  onSuccess: () => {
                    void queryClient.invalidateQueries({
                      queryKey: specKeys.planReview(projectName, slug),
                    });
                  },
                },
              );
            }}
          >
            Start execution
          </Button>
          {launch.isPending && (
            <span
              role="status"
              className="font-mono text-[0.68rem] text-text-tertiary"
            >
              Starting execution…
            </span>
          )}
          {launch.isError && (
            <FormError role="alert">{launch.error.message}</FormError>
          )}
        </div>
      )}

      {receipt !== null && (
        <p
          role="status"
          className="m-0 font-mono text-[0.7rem] leading-relaxed text-green"
        >
          Started execution {receipt.execution.id} in session{" "}
          {receipt.execution.sessionName} from candidate{" "}
          {receipt.deliveryPlan.candidateId}.
        </p>
      )}
    </section>
  );
}
