"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/Button";
import { FormError, FormInput, FormLabel } from "@/components/ui/FormField";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { DeliveryPlanContextType } from "@/lib/specs/delivery-plan";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";
import type { DeliveryPlanAttemptStatus } from "@/lib/specs/schemas";
import {
  useSpecPlanDiffQuery,
  useSpecPlanReviewQuery,
} from "@/lib/specs/queries";
import { specStartedExecutionViewSchema } from "@/lib/specs/view-schemas";
import { workflowDefinitionRecordSchema } from "@/lib/workflow-graph/definition-schemas";

import {
  DeliveryPlanCandidatePanel,
  DeliveryPlanDispositionsTable,
} from "./SpecDeliveryPlanDispositions";
import SpecDeliveryPlanApproval from "./SpecDeliveryPlanApproval";
import SpecDeliveryPlanComments from "./SpecDeliveryPlanComments";
import SpecDeliveryPlanDiff from "./SpecDeliveryPlanDiff";
import { ReaffirmControl } from "./SpecDeliveryPlanReaffirm";
import {
  deliveryPlanGraph,
  type DeliveryPlanGraphNode,
} from "./delivery-plan-graph";

/**
 * The delivery-plan attempt as a reviewer reads it: what shape this execution
 * will take, which criteria each context owns, and — distinctly — whether the
 * shape is still moving. Every fact here comes from the server's review
 * projection; the surface lays it out and classifies nothing.
 */

const logger = createClientLogger("spec-studio-delivery-plan");

const deliveryPlanLaunchResponseSchema = z
  .object({
    execution: specStartedExecutionViewSchema,
    definition: workflowDefinitionRecordSchema,
    deliveryPlan: z
      .object({
        attemptId: z.string().min(1),
        candidateId: z.string().min(1),
        planHash: z.string().min(1),
        compiledDefinitionHash: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * The three states the design separates, plus the three an attempt can also be
 * in. They are rendered distinctly because they answer different questions: a
 * draft shows what WOULD compile, a proposal shows the frozen bytes an
 * approval would bind, and an approval shows the bytes a launch will run.
 */
const ATTEMPT_STATE: Record<
  DeliveryPlanAttemptStatus,
  { label: string; tone: StatusChipTone; summary: string }
> = {
  draft: {
    label: "Open draft",
    tone: "cyan",
    summary:
      "Draft preview. The shape below compiles from the document as it stands and is not frozen — editing the plan changes it.",
  },
  proposed: {
    label: "Proposed",
    tone: "amber",
    summary:
      "Frozen candidate. These are the exact bytes a sign-off would approve; reopening the attempt is what makes them editable again.",
  },
  approved: {
    label: "Approved",
    tone: "green",
    summary:
      "Approved candidate. A launch runs exactly this definition; no later edit can reach it without a new proposal and a new approval.",
  },
  parked: {
    label: "Parked",
    tone: "amber",
    summary:
      "Held for prelaunch review. No workflow execution exists yet, so nothing here holds a graph slot.",
  },
  launched: {
    label: "Launched",
    tone: "violet",
    summary:
      "Launched. The execution below is running the approved candidate as it was compiled.",
  },
  abandoned: {
    label: "Abandoned",
    tone: "neutral",
    summary: "Abandoned. This attempt is history; nothing will launch from it.",
  },
};

const CONTEXT_TYPE_TONE: Record<DeliveryPlanContextType, StatusChipTone> = {
  delivery: "cyan",
  integration: "violet",
  closeout: "amber",
};

function AttemptHeader({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const state = ATTEMPT_STATE[review.attempt.status];
  return (
    <header data-attempt-state={review.attempt.status}>
      <div className="flex flex-wrap items-baseline gap-xs">
        <StatusChip tone={state.tone}>{state.label}</StatusChip>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          attempt {review.attempt.id} · draft revision{" "}
          {review.attempt.draftRevision} · pinned revision{" "}
          {review.attempt.pinnedRevisionId}
        </span>
      </div>
      <p className="mt-xs mb-0 font-mono text-[0.72rem] leading-relaxed text-text-secondary">
        {state.summary}
      </p>
      <p className="mt-xs mb-0 font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
        Next: {review.nextAct.reason} <code>{review.nextAct.command}</code> (
        {review.nextAct.actor})
      </p>
    </header>
  );
}

function DeliveryPlanLaunchControl({
  projectName,
  review,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
}): React.JSX.Element | null {
  const [sessionName, setSessionName] = useState("");
  const queryClient = useQueryClient();
  const { attempt, approval } = review;
  const launch = useSpecActionMutation<
    { revisionId: string; sessionName: string },
    z.infer<typeof deliveryPlanLaunchResponseSchema>
  >(
    projectName,
    attempt.specSlug,
    "start-execution",
    deliveryPlanLaunchResponseSchema,
  );
  const approvedCandidate =
    approval !== null &&
    attempt.candidateId !== null &&
    attempt.planHash !== null &&
    attempt.compiledDefinitionHash !== null &&
    approval.candidateId === attempt.candidateId &&
    approval.planHash === attempt.planHash &&
    approval.compiledDefinitionHash === attempt.compiledDefinitionHash &&
    (attempt.status === "approved" || attempt.status === "parked");

  if (!approvedCandidate) return null;

  const normalizedSessionName = sessionName.trim();
  const receipt = launch.data?.deliveryPlan ?? null;
  const receiptMatchesApproval =
    receipt === null ||
    (receipt.attemptId === attempt.id &&
      receipt.candidateId === approval.candidateId &&
      receipt.planHash === approval.planHash &&
      receipt.compiledDefinitionHash === approval.compiledDefinitionHash);

  return (
    <section
      aria-label="Plan launch"
      className="rounded-md border border-solid border-[var(--cc-green-border)] bg-green-glow p-md"
    >
      <h4 className="m-0 font-display text-[0.85rem] font-extrabold text-text-primary">
        Launch approved candidate
      </h4>
      <p className="mt-xs mb-sm font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        Start candidate <code>{approval.candidateId}</code> with compiled
        definition <code>{approval.compiledDefinitionHash}</code>. The delivery
        plan already owns the graph and delivery scope.
      </p>
      <div className="flex flex-wrap items-end gap-sm">
        <div className="w-[260px] max-w-full">
          <FormLabel htmlFor="delivery-plan-session-name">
            Session name
          </FormLabel>
          <FormInput
            id="delivery-plan-session-name"
            value={sessionName}
            onChange={(event) => setSessionName(event.currentTarget.value)}
            placeholder="Required session name"
          />
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={launch.isPending}
          disabled={normalizedSessionName.length === 0}
          onClick={() => {
            if (normalizedSessionName.length === 0) return;
            logger.info("spec_studio.delivery_plan.launch_requested", {
              specSlug: attempt.specSlug,
              attemptId: attempt.id,
              candidateId: approval.candidateId,
              compiledDefinitionHash: approval.compiledDefinitionHash,
            });
            launch.mutate(
              {
                revisionId: attempt.pinnedRevisionId,
                sessionName: normalizedSessionName,
              },
              {
                onSuccess: (result) => {
                  const identityMatchesApproval =
                    result.deliveryPlan.attemptId === attempt.id &&
                    result.deliveryPlan.candidateId === approval.candidateId &&
                    result.deliveryPlan.planHash === approval.planHash &&
                    result.deliveryPlan.compiledDefinitionHash ===
                      approval.compiledDefinitionHash;
                  logger.info("spec_studio.delivery_plan.launch_completed", {
                    specSlug: attempt.specSlug,
                    attemptId: result.deliveryPlan.attemptId,
                    candidateId: result.deliveryPlan.candidateId,
                    compiledDefinitionHash:
                      result.deliveryPlan.compiledDefinitionHash,
                    executionId: result.execution.id,
                  });
                  if (!identityMatchesApproval) {
                    logger.error(
                      "spec_studio.delivery_plan.launch_receipt_mismatch",
                      {
                        specSlug: attempt.specSlug,
                        approvedAttemptId: attempt.id,
                        receivedAttemptId: result.deliveryPlan.attemptId,
                        approvedCandidateId: approval.candidateId,
                        receivedCandidateId: result.deliveryPlan.candidateId,
                        approvedCompiledDefinitionHash:
                          approval.compiledDefinitionHash,
                        receivedCompiledDefinitionHash:
                          result.deliveryPlan.compiledDefinitionHash,
                        executionId: result.execution.id,
                      },
                    );
                  }
                  void queryClient.invalidateQueries({
                    queryKey: specKeys.planReview(
                      projectName,
                      attempt.specSlug,
                    ),
                  });
                },
                onError: (error) => {
                  logger.warn("spec_studio.delivery_plan.launch_failed", {
                    specSlug: attempt.specSlug,
                    attemptId: attempt.id,
                    candidateId: approval.candidateId,
                    error: error.message,
                  });
                },
              },
            );
          }}
        >
          Start execution
        </Button>
      </div>
      {launch.isError && (
        <FormError role="alert">{launch.error.message}</FormError>
      )}
      {launch.data !== undefined && receipt !== null && (
        <p
          role="status"
          className={`mt-sm mb-0 font-mono text-[0.7rem] ${receiptMatchesApproval ? "text-green" : "text-red"}`}
        >
          {receiptMatchesApproval
            ? `Started execution ${launch.data.execution.id} from candidate ${receipt.candidateId} · ${receipt.compiledDefinitionHash}.`
            : `Execution ${launch.data.execution.id} started, but its candidate receipt does not match the approved identity shown here.`}
        </p>
      )}
    </section>
  );
}

function GraphNodeCard({
  node,
}: {
  node: DeliveryPlanGraphNode;
}): React.JSX.Element {
  return (
    <li
      data-context-id={node.contextId}
      className="flex min-w-[200px] flex-col gap-[4px] rounded-md border border-solid border-border-subtle bg-bg-raised p-sm"
    >
      <div className="flex flex-wrap items-baseline gap-xs">
        <StatusChip tone={CONTEXT_TYPE_TONE[node.contextType]}>
          {node.contextType}
        </StatusChip>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {node.contextId}
        </span>
      </div>
      <span className="font-display text-[0.8rem] font-extrabold text-text-primary">
        {node.title}
      </span>
      <span className="font-mono text-[0.68rem] text-text-tertiary">
        {node.ownedCriterionCount} owned criteria · {node.taskCount} tasks
      </span>
      {node.dependsOnContextIds.length > 0 && (
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          after {node.dependsOnContextIds.join(", ")}
        </span>
      )}
    </li>
  );
}

function ContextGraph({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const graph = deliveryPlanGraph(review.document);
  if (graph.ranks.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        This plan declares no contexts yet.
      </p>
    );
  }
  return (
    <section aria-label="Context graph">
      <ol className="m-0 flex list-none gap-md overflow-x-auto p-0">
        {graph.ranks.map((rank, index) => (
          <li key={index} className="flex flex-col gap-xs">
            <span className="font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
              Wave {index + 1}
            </span>
            <ul className="m-0 flex list-none flex-col gap-sm p-0">
              {rank.map((node) => (
                <GraphNodeCard key={node.contextId} node={node} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <h4 className="mt-md mb-xs font-display text-[0.78rem] font-extrabold text-text-primary">
        Dependency edges
      </h4>
      {graph.edges.length === 0 ? (
        <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
          No context depends on another; every context can start immediately.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {graph.edges.map((edge) => (
            <li
              key={edge.edgeId}
              className="py-[2px] font-mono text-[0.7rem] text-text-tertiary"
            >
              {edge.fromContextId} → {edge.toContextId}
            </li>
          ))}
        </ul>
      )}
      {graph.cyclicContextIds.length > 0 && (
        <p className="mt-xs mb-0 font-mono text-[0.7rem] text-red">
          These contexts sit on a dependency cycle and cannot be ordered:{" "}
          {graph.cyclicContextIds.join(", ")}. Remove one of the edges between
          them before proposing.
        </p>
      )}
      {graph.danglingEdges.length > 0 && (
        <p className="mt-xs mb-0 font-mono text-[0.7rem] text-red">
          These edges name a context this plan does not define:{" "}
          {graph.danglingEdges
            .map((edge) => `${edge.fromContextId} → ${edge.toContextId}`)
            .join(", ")}
          . Add the context or drop the edge before proposing.
        </p>
      )}
    </section>
  );
}

function ContextCards({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const criteriaById = new Map(
    review.criteria.map((criterion) => [
      criterion.criterionElementId,
      criterion,
    ]),
  );
  const wiringByContext = new Map(
    review.wiringByContext.map((entry) => [entry.contextId, entry.entries]),
  );
  return (
    <section aria-label="Contexts">
      <ul className="m-0 flex list-none flex-col gap-md p-0">
        {review.document.contexts.map((context) => {
          const tasks = review.document.tasks
            .filter((task) => task.contextId === context.contextId)
            .sort((left, right) => left.order - right.order);
          const wiring = wiringByContext.get(context.contextId) ?? [];
          return (
            <li
              key={context.contextId}
              data-context-card={context.contextId}
              className="rounded-md border border-solid border-border-subtle bg-bg-raised p-md"
            >
              <div className="flex flex-wrap items-baseline gap-xs">
                <StatusChip tone={CONTEXT_TYPE_TONE[context.contextType]}>
                  {context.contextType}
                </StatusChip>
                <h4 className="m-0 font-display text-[0.9rem] font-extrabold text-text-primary">
                  {context.title}
                </h4>
                <span className="font-mono text-[0.68rem] text-text-tertiary">
                  {context.contextId}
                </span>
              </div>

              <h5 className="mt-md mb-xs font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
                Owned criteria ({context.criterionElementIds.length})
              </h5>
              {context.criterionElementIds.length === 0 ? (
                <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
                  This {context.contextType} context owns no criterion; its
                  acceptance contract is the whole of what it is held to.
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {context.criterionElementIds.map((criterionElementId) => {
                    const criterion = criteriaById.get(criterionElementId);
                    return (
                      <li
                        key={criterionElementId}
                        className="flex flex-wrap items-baseline gap-xs py-[2px]"
                      >
                        <StatusChip tone="neutral">
                          {criterion?.handle ?? criterionElementId}
                        </StatusChip>
                        <span className="font-mono text-[0.7rem] leading-relaxed text-text-secondary">
                          {criterion?.text ??
                            `The pinned revision carries no criterion ${criterionElementId}.`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <h5 className="mt-md mb-xs font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
                Acceptance contract
              </h5>
              <ol className="m-0 pl-md">
                {context.acceptanceContract.map((line, index) => (
                  <li
                    key={index}
                    className="py-[2px] font-mono text-[0.7rem] leading-relaxed text-text-secondary"
                  >
                    {line}
                  </li>
                ))}
              </ol>

              <h5 className="mt-md mb-xs font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
                Tasks ({tasks.length})
              </h5>
              <ol className="m-0 pl-md">
                {tasks.map((task) => (
                  <li key={task.taskId} className="py-[2px]">
                    <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
                      {task.title}
                    </span>{" "}
                    <span className="font-mono text-[0.68rem] text-text-tertiary">
                      {task.taskId}
                    </span>
                  </li>
                ))}
              </ol>

              {wiring.length > 0 && (
                <>
                  <h5 className="mt-md mb-xs font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
                    Production wiring
                  </h5>
                  <ul className="m-0 list-none p-0">
                    {wiring.map((entry) => (
                      <li
                        key={entry}
                        className="py-[2px] font-mono text-[0.7rem] text-text-tertiary"
                      >
                        {entry}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The diff between the two most recent proposals. Two snapshots is the whole
 * question a reviewer has after a reopen — what changed since the version I
 * last read — so the surface answers it without asking them to pick ids.
 */
function LatestSnapshotDiff({
  projectName,
  review,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
}): React.JSX.Element | null {
  const ordered = [...review.snapshots].sort(
    (left, right) => left.draftRevision - right.draftRevision,
  );
  const from = ordered.at(-2) ?? null;
  const to = ordered.at(-1) ?? null;
  const query = useSpecPlanDiffQuery(
    projectName,
    review.attempt.specSlug,
    from?.id ?? null,
    to?.id ?? null,
  );

  if (from === null || to === null) {
    return (
      <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
        This attempt has frozen fewer than two proposals, so there is nothing to
        compare yet.
      </p>
    );
  }
  if (query.isPending) {
    return (
      <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
        Comparing the last two proposals…
      </p>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <p className="m-0 font-mono text-[0.7rem] text-red">
        {query.error instanceof Error
          ? query.error.message
          : "The snapshot diff could not be read."}
      </p>
    );
  }
  return (
    <SpecDeliveryPlanDiff
      diff={query.data.diff}
      fromLabel={`draft revision ${query.data.from.draftRevision}`}
      toLabel={`draft revision ${query.data.to.draftRevision}`}
    />
  );
}

export default function SpecDeliveryPlanReview({
  projectName,
  slug,
}: {
  projectName: string;
  slug: string;
}): React.JSX.Element {
  const query = useSpecPlanReviewQuery(projectName, slug);

  if (query.isPending) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        Reading the delivery plan…
      </p>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-amber">
        {query.error instanceof Error
          ? query.error.message
          : "The delivery plan could not be read."}
      </p>
    );
  }
  if (query.data === null) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-amber">
        This spec has no delivery plan attempt. Open one with cctl spec plan
        open {slug}.
      </p>
    );
  }

  const review = query.data;
  return (
    <div className="flex flex-col gap-lg">
      <AttemptHeader review={review} />
      <DeliveryPlanCandidatePanel review={review} />
      <SpecDeliveryPlanApproval projectName={projectName} review={review} />
      <DeliveryPlanLaunchControl projectName={projectName} review={review} />
      <ContextGraph review={review} />
      <ContextCards review={review} />
      <div>
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Dispositions
        </h4>
        <DeliveryPlanDispositionsTable
          criteria={review.criteria}
          renderRowAction={(criterion) => (
            <ReaffirmControl
              projectName={projectName}
              slug={slug}
              criterion={criterion}
            />
          )}
        />
      </div>
      <div>
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Comments
        </h4>
        <SpecDeliveryPlanComments projectName={projectName} review={review} />
      </div>
      <div>
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Since the previous proposal
        </h4>
        <LatestSnapshotDiff projectName={projectName} review={review} />
      </div>
    </div>
  );
}
