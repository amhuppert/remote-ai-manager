"use client";

import { useId, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/Button";
import {
  FormInput,
  FormLabel,
  FormHint,
  FormError,
} from "@/components/ui/FormField";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { mutationFetch } from "@/lib/api/fetcher";
import { createClientLogger } from "@/lib/logging/client-logger";
import { useSessionsQuery } from "@/lib/sessions/queries";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { specQueries } from "@/lib/specs/queries";
import {
  specAcceptanceReviewSchema,
  specExecutionRowSchema,
  specDeliveryBasisSchema,
} from "@/lib/specs/schemas";
import {
  deliveryReviewViewSchema,
  type AcceptanceReviewRequest,
  type DeliveryApprovalRequest,
  type DeliveryContinuationRequest,
  type DeliveryReplacementRequest,
  type DeliveryReviewView,
} from "@/lib/specs/delivery-review-schemas";
import { deliveryPlanMutationViewSchema } from "@/lib/specs/delivery-plan-views";
import SpecDeliveryReview from "./SpecDeliveryReview";

const logger = createClientLogger("spec-studio-delivery-review");
const mergeReceiptSchema = z.object({ jobId: z.string() });

export default function SpecDeliveryReviewPanel({
  projectName,
  slug,
}: {
  projectName: string;
  slug: string;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [continuedId, setContinuedId] = useState<string | undefined>();
  const [mergeStarted, setMergeStarted] = useState(false);
  const query = useQuery(
    specQueries.deliveryReview(
      projectName,
      slug,
      continuedId ?? params?.get("execution") ?? undefined,
    ),
  );
  const sessions = useSessionsQuery(projectName);
  const acceptance = useSpecActionMutation<
    AcceptanceReviewRequest,
    z.infer<typeof specAcceptanceReviewSchema>
  >(projectName, slug, "review-acceptance", specAcceptanceReviewSchema);
  const approval = useSpecActionMutation<
    DeliveryApprovalRequest,
    DeliveryReviewView
  >(projectName, slug, "approve-delivery-review", deliveryReviewViewSchema);
  const continuation = useSpecActionMutation<
    DeliveryContinuationRequest,
    z.infer<typeof specExecutionRowSchema>
  >(projectName, slug, "continue-delivery", specExecutionRowSchema);
  const replacement = useSpecActionMutation<
    DeliveryReplacementRequest,
    z.infer<typeof deliveryPlanMutationViewSchema>
  >(projectName, slug, "replace-delivery", deliveryPlanMutationViewSchema);
  const merge = useMutation({
    mutationFn: (sessionName: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge`,
        "delivery-review-merge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoResolve: true }),
        },
        mergeReceiptSchema,
      ),
  });
  if (query.isPending)
    return (
      <p className="text-[0.8rem] text-text-secondary">
        Reading delivery review…
      </p>
    );
  if (query.isError)
    return (
      <div>
        <FormError role="alert">{query.error.message}</FormError>
        <Button
          size="sm"
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry delivery review
        </Button>
      </div>
    );
  const view = query.data;
  if (!view) return null;
  const active =
    view.execution &&
    ["running", "definition_review", "abandoning"].includes(
      view.execution.state,
    )
      ? view.execution
      : null;
  const basis = view.execution?.delivery_basis_json
    ? specDeliveryBasisSchema.parse(
        JSON.parse(view.execution.delivery_basis_json),
      )
    : null;
  const mergeSession = params?.get("mergeSession") ?? null;
  const pending =
    acceptance.isPending ||
    approval.isPending ||
    continuation.isPending ||
    replacement.isPending ||
    merge.isPending;
  const canContinueMerge =
    mergeSession !== null &&
    active?.session_name === mergeSession &&
    !mergeStarted;

  return (
    <div className="mx-auto grid w-full max-w-[1000px] gap-lg">
      {basis && (
        <div className="rounded-lg border border-solid border-border-dim bg-bg-base p-lg">
          <div className="mb-sm flex flex-wrap items-center gap-sm">
            <StatusChip tone={basis.kind === "external" ? "green" : "cyan"}>
              {basis.kind === "external"
                ? "External delivery recorded"
                : "Session delivery"}
            </StatusChip>
            {view.execution?.session_name && (
              <span className="font-mono text-[0.75rem] text-text-secondary">
                {view.execution.session_name}
              </span>
            )}
          </div>
          <p className="m-0 text-[0.78rem] leading-relaxed text-text-secondary">
            {basis.kind === "external"
              ? "You recorded that this scope was already delivered outside Command Center’s merge flow."
              : "Delivery can finish here while the original workflow keeps its recorded outcome."}
          </p>
          {basis.note && (
            <p className="mt-sm mb-0 text-[0.78rem] text-text-secondary">
              {basis.note}
            </p>
          )}
          {(basis.sourceWorkflowExecutionIds.length > 0 ||
            basis.commitRefs.length > 0) && (
            <details className="mt-md text-[0.72rem] text-text-tertiary">
              <summary className="cursor-pointer">Delivery references</summary>
              <ul className="mb-0 grid gap-xs pl-lg">
                {basis.sourceWorkflowExecutionIds.map((id) => (
                  <li key={id} className="break-all">
                    Workflow: {id}
                  </li>
                ))}
                {basis.commitRefs.map((ref) => (
                  <li key={ref} className="break-all">
                    Commit: {ref}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {mergeStarted && (
        <p
          role="status"
          className="m-0 rounded-lg border border-solid border-green bg-green-glow p-lg text-[0.8rem] text-green"
        >
          Merge started. Validation and publication progress are available in
          the session.
        </p>
      )}
      <SpecDeliveryReview
        key={`review:${view.revisionId}`}
        view={view}
        pending={pending}
        canContinueMerge={canContinueMerge}
        onReview={async (input) => {
          logger.info("spec_studio.delivery.acceptance_requested", {
            slug,
            decision: input.decision,
            criterionCount: input.criterionIds.length,
          });
          await acceptance.mutateAsync(input);
          await query.refetch();
        }}
        onApprove={async (waiveRemaining, note) => {
          if (!active)
            throw new Error("Choose how to continue delivery first.");
          logger.info("spec_studio.delivery.approval_requested", {
            slug,
            executionId: active.id,
            waiveRemaining,
            continueMerge: canContinueMerge,
          });
          await approval.mutateAsync({
            revisionId: view.revisionId,
            executionId: active.id,
            expectedContentHash: view.contentHash,
            expectedReviewId: view.lastReviewId,
            waiveRemaining,
            note,
          });
          await query.refetch();
          if (canContinueMerge && mergeSession) {
            await merge.mutateAsync(mergeSession);
            setMergeStarted(true);
          }
        }}
      />
      <DeliveryContinuationForm
        key={`continuation:${view.execution?.id ?? view.revisionId}`}
        view={view}
        pending={pending}
        sessions={(sessions.data ?? []).map((session) => session.sessionName)}
        sessionsError={sessions.error?.message}
        initialSession={active?.session_name ?? mergeSession ?? undefined}
        onContinue={async (input) => {
          logger.info("spec_studio.delivery.continuation_requested", {
            slug,
            mode: input.mode,
            executionId: active?.id ?? null,
          });
          if (input.mode === "replacement") {
            const opened = await replacement.mutateAsync({
              revisionId: view.revisionId,
              expectedExecutionId: active?.id ?? null,
              note:
                input.note ||
                "Delivery will continue through a replacement workflow.",
            });
            window.location.assign(opened.workflowDefinition.builderHref);
            return;
          }
          const execution = await continuation.mutateAsync({
            ...input,
            mode: input.mode,
            revisionId: view.revisionId,
            expectedExecutionId: active?.id ?? null,
          });
          setContinuedId(execution.id);
          setMergeStarted(false);
          const nextParams = new URLSearchParams(params?.toString());
          nextParams.set("execution", execution.id);
          router.replace(`${pathname}?${nextParams.toString()}`, {
            scroll: false,
          });
        }}
      />
    </div>
  );
}

type ContinuationChoice = Omit<
  DeliveryContinuationRequest,
  "revisionId" | "expectedExecutionId" | "mode"
> & {
  mode: DeliveryContinuationRequest["mode"] | "replacement";
};

function DeliveryContinuationForm({
  view,
  pending,
  sessions,
  sessionsError,
  initialSession,
  onContinue,
}: {
  view: DeliveryReviewView;
  pending: boolean;
  sessions: string[];
  sessionsError?: string;
  initialSession?: string;
  onContinue(input: ContinuationChoice): Promise<void>;
}) {
  const [mode, setMode] = useState<ContinuationChoice["mode"]>("session");
  const [sessionName, setSessionName] = useState(
    initialSession ?? (sessions.length === 1 ? sessions[0] : ""),
  );
  const [workflowExecutionId, setWorkflowExecutionId] = useState("");
  const [note, setNote] = useState("");
  const [commitRefs, setCommitRefs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const requiresSession = mode === "session" || mode === "workflow";
  const effectiveSession =
    sessionName || (sessions.length === 1 ? sessions[0] : "");
  return (
    <details
      open={
        !view.execution ||
        view.execution.state === "abandoned" ||
        view.execution.state === "abandoning"
      }
      className="rounded-lg border border-solid border-border-default bg-bg-surface p-lg"
    >
      <summary className="cursor-pointer text-[0.9rem] font-semibold text-text-primary">
        Continue delivery or record delivery elsewhere
      </summary>
      <p className="mt-sm mb-lg text-[0.8rem] leading-relaxed text-text-secondary">
        Choose where the work continues. Approved requirements, design, and
        applicable acceptance decisions stay in place.
      </p>
      <div className="grid gap-md">
        <div>
          <FormLabel htmlFor={`${id}-mode`}>Delivery path</FormLabel>
          <Select
            value={mode}
            onValueChange={(value) => {
              if (
                value === "session" ||
                value === "workflow" ||
                value === "replacement" ||
                value === "external"
              )
                setMode(value);
            }}
            disabled={pending}
          >
            <SelectTrigger id={`${id}-mode`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="session">Finish in this session</SelectItem>
              <SelectItem value="workflow">Use another workflow</SelectItem>
              <SelectItem value="replacement">
                Start a replacement workflow
              </SelectItem>
              <SelectItem value="external">Record external delivery</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {requiresSession && (
          <div>
            <FormLabel htmlFor={`${id}-session`}>Delivery session</FormLabel>
            <Select
              value={effectiveSession}
              onValueChange={setSessionName}
              disabled={pending}
            >
              <SelectTrigger id={`${id}-session`}>
                <SelectValue placeholder="Choose a session" />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem key={session} value={session}>
                    {session}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sessionsError && <FormError>{sessionsError}</FormError>}
          </div>
        )}
        {(mode === "workflow" || mode === "external") && (
          <div>
            <FormLabel htmlFor={`${id}-workflow`}>
              Workflow execution {mode === "external" ? "(optional)" : ""}
            </FormLabel>
            <FormInput
              id={`${id}-workflow`}
              value={workflowExecutionId}
              disabled={pending}
              onChange={(event) => setWorkflowExecutionId(event.target.value)}
              placeholder="Execution ID from workflow history"
            />
            <FormHint>
              A source reference records where work happened. Only applicable
              verified results count as automated proof.
            </FormHint>
          </div>
        )}
        {mode === "external" && (
          <div>
            <FormLabel htmlFor={`${id}-commits`}>
              Commit references (optional)
            </FormLabel>
            <FormInput
              id={`${id}-commits`}
              value={commitRefs}
              disabled={pending}
              onChange={(event) => setCommitRefs(event.target.value)}
              placeholder="Separate references with commas"
            />
          </div>
        )}
        <div>
          <FormLabel htmlFor={`${id}-note`}>
            {mode === "external"
              ? "Delivery note (optional)"
              : "Continuation note (optional)"}
          </FormLabel>
          <FormInput
            id={`${id}-note`}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <p className="m-0 text-[0.75rem] leading-relaxed text-text-secondary">
          {mode === "external"
            ? `Record all ${view.criteria.filter((criterion) => criterion.inScope).length} criteria in this delivery scope as already delivered, attributed to you.`
            : mode === "replacement"
              ? "Retire the current attempt and open a replacement plan in Workflow Builder."
              : "The current attempt will be retired. Delivery stays pending until this session merges successfully."}
        </p>
        {error && <FormError role="alert">{error}</FormError>}
        <div>
          <Button
            size="sm"
            touch
            disabled={
              pending ||
              (requiresSession && !effectiveSession) ||
              (mode === "workflow" && !workflowExecutionId.trim())
            }
            loading={pending}
            onClick={() => {
              setError(null);
              void onContinue({
                mode,
                sessionName: effectiveSession || undefined,
                workflowExecutionId:
                  mode === "workflow" || mode === "external"
                    ? workflowExecutionId.trim() || undefined
                    : undefined,
                commitRefs:
                  mode === "external"
                    ? commitRefs
                        .split(",")
                        .map((ref) => ref.trim())
                        .filter(Boolean)
                    : [],
                note: note.trim(),
              }).catch((failure: unknown) =>
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Delivery continuation failed.",
                ),
              );
            }}
          >
            {mode === "external"
              ? "Record external delivery"
              : mode === "replacement"
                ? "Open replacement plan"
                : "Continue delivery"}
          </Button>
        </div>
      </div>
    </details>
  );
}
