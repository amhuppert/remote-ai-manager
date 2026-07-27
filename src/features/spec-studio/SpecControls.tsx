"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/AlertDialog";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import {
  FormError,
  FormGroup,
  FormHint,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import { RadioGroup, RadioGroupOption } from "@/components/ui/RadioGroup";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import { specSlugSchema } from "@/lib/specs/handles";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import {
  COMBINED_APPROVAL_DIAL,
  policyChangeRequiresHardConfirmation,
  resolveDial,
} from "@/lib/specs/policy";
import {
  useSpecIntegrityQuery,
  type SpecDetailView,
} from "@/lib/specs/queries";
import {
  specPolicyChangeResultSchema,
  specStartedExecutionViewSchema,
  type CriterionDeliveryProjection,
  type IntegrityReport,
  type SpecExecutionView,
  type SpecGateAdmissionView,
} from "@/lib/specs/view-schemas";
import {
  specAliasSchema,
  specApprovalRowSchema,
  specCriterionDispositionRowSchema,
  specElementSchema,
  specElementVersionSchema,
  specExecutionRowSchema,
  specGatePolicySchema,
  specRevisionSchema,
  specSchema,
  specWaiverRowSchema,
  type SpecCriterionDisposition,
  type SpecCriterionDispositionRow,
  type SpecGate,
  type SpecGateDial,
  type SpecGatePolicy,
  type SpecGatePreset,
  type SpecRevisionSnapshot,
  type SpecWaiverRow,
  type TaskElementPayload,
} from "@/lib/specs/schemas";
import { workflowDefinitionRecordSchema } from "@/lib/workflow-graph/definition-schemas";

import { gateLabels } from "./presentation";
import { formatEvidenceKind } from "./SpecEvidenceLintTrace";
import {
  openDraftForPolicyImpact,
  PolicyImpactPreview,
  type PolicyImpactDraft,
} from "./SpecPolicyImpact";

const logger = createClientLogger("spec-studio-controls");
const GATES: readonly SpecGate[] = [
  "requirements",
  "design",
  "plan",
  "execution_start",
  "delivery",
];

const presetLabels: Record<SpecGatePreset, string> = {
  "contract-bearing": "Contract-bearing",
  exploratory: "Exploratory",
  "fast-path": "Fast path",
};

const presetDescriptions: Record<SpecGatePreset, string> = {
  "contract-bearing":
    "Every authoring and delivery transition requires a human gate.",
  exploratory:
    "Authoring transitions notify; delivery remains gated and cannot merge.",
  "fast-path":
    "Requirements, design, and plan share one combined proposal approval.",
};

const gateDescriptions: Record<SpecGate, string> = {
  requirements: "Admits the requirements contract.",
  design: "Admits the design narrative and decisions.",
  plan: "Admits the execution task plan.",
  execution_start: "Admits the pinned scope and generated definition.",
  delivery: "Admits delivery claims and merge readiness.",
};

const dispositionLabels: Record<SpecCriterionDisposition, string> = {
  in_scope: "In scope",
  deferred: "Deferred",
  waived: "Waived",
  delivered_elsewhere: "Delivered elsewhere",
};

/** Rendered verbatim from the server's `deliveryProjection` (F26). */
const proofStatePresentation: Record<
  CriterionDeliveryProjection["proofState"],
  { label: string; tone: StatusChipTone }
> = {
  proven_merged: { label: "Proven & merged", tone: "green" },
  proof_recorded: { label: "Proof recorded", tone: "cyan" },
  waived: { label: "Waived", tone: "amber" },
  delivered_elsewhere: { label: "Delivered elsewhere", tone: "neutral" },
  awaiting_proof: { label: "Awaiting proof", tone: "neutral" },
};

export const renameSpecResultSchema = z
  .object({ spec: specSchema, alias: specAliasSchema })
  .strict();
export type RenameSpecResultView = z.infer<typeof renameSpecResultSchema>;

type GateSelection = SpecGateDial | "inherit";

export function RenameSpecDialog({
  currentSlug,
  currentName,
  pending,
  error,
  onRename,
}: {
  currentSlug: string;
  currentName: string;
  pending: boolean;
  error: string | null;
  onRename(input: { slug: string; name?: string }): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState(currentSlug);
  const [name, setName] = useState(currentName);
  const trimmedSlug = slug.trim();
  const trimmedName = name.trim();
  const slugValid = specSlugSchema.safeParse(trimmedSlug).success;
  const canRename = slugValid && trimmedSlug !== currentSlug;

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setSlug(currentSlug);
    setName(currentName);
  }

  function handleRename(): void {
    onRename({
      slug: trimmedSlug,
      ...(trimmedName.length > 0 && trimmedName !== currentName
        ? { name: trimmedName }
        : {}),
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Rename
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="default">
        <AlertDialogTitle>Rename spec</AlertDialogTitle>
        <AlertDialogDescription>
          The current slug {currentSlug} stays behind as an alias, so previously
          copied references and deep links keep resolving.
        </AlertDialogDescription>

        <FormGroup layoutClassName="mt-lg">
          <FormLabel htmlFor="spec-rename-slug">New slug</FormLabel>
          <FormInput
            id="spec-rename-slug"
            aria-label="New slug"
            value={slug}
            onChange={(event) => setSlug(event.currentTarget.value)}
            autoComplete="off"
          />
          {!slugValid && (
            <FormHint>Use lowercase kebab-case: letters and digits.</FormHint>
          )}
        </FormGroup>
        <FormGroup layoutClassName="mt-md mb-sm">
          <FormLabel htmlFor="spec-rename-name">Name</FormLabel>
          <FormInput
            id="spec-rename-name"
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoComplete="off"
          />
        </FormGroup>
        {error !== null && <FormError role="alert">{error}</FormError>}
        <AlertDialogActions>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRename}
            loading={pending}
            disabled={!canRename}
          >
            Rename spec
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface PolicyDialogProps {
  currentPolicy: SpecGatePolicy;
  pending: boolean;
  error: string | null;
  onChangePolicy(input: {
    proposedPolicy: SpecGatePolicy;
    hardConfirmed: boolean;
  }): void;
  specSlug?: string;
  backHref?: string;
  /**
   * The spec's open draft, for the confirmation's impact preview. Omitted by
   * callers that have no spec detail to read one from, which the preview
   * reports as no open draft rather than inventing a stage.
   */
  openDraft?: PolicyImpactDraft | null;
}

export function PolicyDialog(props: PolicyDialogProps): React.JSX.Element {
  const policyKey = JSON.stringify(props.currentPolicy);
  return <PolicyEditor key={policyKey} {...props} />;
}

function PolicyEditor({
  currentPolicy,
  pending,
  error,
  onChangePolicy,
  specSlug,
  backHref,
  openDraft = null,
}: PolicyDialogProps): React.JSX.Element {
  const [preset, setPreset] = useState<SpecGatePreset>(currentPolicy.preset);
  const [overrides, setOverrides] = useState<Record<SpecGate, GateSelection>>(
    () => policyOverrides(currentPolicy),
  );
  const [confirmationPolicy, setConfirmationPolicy] =
    useState<SpecGatePolicy | null>(null);
  const confirmationAccepted = useRef(false);
  const proposedPolicy = proposedGatePolicy(preset, overrides);
  const confirmationLoosens =
    confirmationPolicy !== null &&
    policyChoiceLoosens(currentPolicy, confirmationPolicy);

  function showPolicy(policy: SpecGatePolicy): void {
    setPreset(policy.preset);
    setOverrides(policyOverrides(policy));
  }

  // `policyChangeRequiresHardConfirmation` is the same predicate the transition
  // enforces, so it — and only it — decides whether the modal opens. Loosening
  // is a copy signal: it escalates the warning, never the requirement.
  function proposePolicy(policy: SpecGatePolicy): void {
    showPolicy(policy);
    const loosensPolicy = policyChoiceLoosens(currentPolicy, policy);
    const requiresHardConfirmation = policyChangeRequiresHardConfirmation(
      currentPolicy,
      policy,
    );
    logger.info("spec_studio.policy_change.requested", {
      currentPreset: currentPolicy.preset,
      proposedPreset: policy.preset,
      loosensPolicy,
      requiresHardConfirmation,
    });
    if (requiresHardConfirmation) {
      setConfirmationPolicy(policy);
      logger.info("spec_studio.policy_change.confirmation_required", {
        currentPreset: currentPolicy.preset,
        proposedPreset: policy.preset,
        loosensPolicy,
        requiresHardConfirmation,
      });
      return;
    }

    onChangePolicy({
      proposedPolicy: policy,
      hardConfirmed: false,
    });
  }

  function discardConfirmation(): void {
    showPolicy(currentPolicy);
    setConfirmationPolicy(null);
    logger.info("spec_studio.policy_change.confirmation_cancelled", {
      currentPreset: currentPolicy.preset,
    });
  }

  // The only site allowed to assert `hardConfirmed: true` — a human clicked it.
  function confirmPolicyChange(): void {
    if (confirmationPolicy === null) return;
    confirmationAccepted.current = true;
    const policy = confirmationPolicy;
    setConfirmationPolicy(null);
    logger.info("spec_studio.policy_change.confirmed", {
      currentPreset: currentPolicy.preset,
      proposedPreset: policy.preset,
      loosensPolicy: policyChoiceLoosens(currentPolicy, policy),
      requiresHardConfirmation: true,
    });
    onChangePolicy({
      proposedPolicy: policy,
      hardConfirmed: true,
    });
  }

  return (
    <section
      aria-labelledby="gate-policy-heading"
      aria-busy={pending}
      className="mx-auto max-w-[920px]"
    >
      <header className="border-x-0 border-t-0 border-b border-solid border-border-dim pt-[10px] pb-[12px]">
        {specSlug !== undefined && backHref !== undefined && (
          <Link
            href={backHref}
            className="inline-flex min-h-[28px] items-center gap-[6px] font-mono text-[0.72rem] text-text-tertiary no-underline hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
          >
            ← {specSlug}
          </Link>
        )}
        <div className="mt-[3px] flex items-baseline gap-[10px] max-768:flex-col max-768:items-start max-768:gap-xs">
          <h1
            id="gate-policy-heading"
            className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary"
          >
            Gate policy
          </h1>
          <span className="font-mono text-[0.72rem] text-text-tertiary">
            preset supplies the five dials · overrides are sparse and visible ·
            resolved like workflow cascades
          </span>
        </div>
      </header>

      <div className="mt-[14px] rounded-lg border border-solid border-border-subtle bg-bg-base px-[20px] py-[18px] max-768:px-md max-768:py-md">
        <RadioGroup
          aria-label="Gate policy preset"
          value={preset}
          disabled={pending}
          onValueChange={(value) => {
            const nextPreset = value as SpecGatePreset;
            proposePolicy({ preset: nextPreset });
          }}
        >
          <div className="grid grid-cols-3 gap-[10px] max-768:grid-cols-1">
            {(Object.keys(presetLabels) as SpecGatePreset[]).map((value) => (
              <div
                key={value}
                data-selected={preset === value}
                className="rounded-md border border-solid border-border-subtle bg-bg-base px-[13px] py-[11px] transition-colors hover:border-border-strong data-[selected=true]:border-cyan-dim data-[selected=true]:bg-cyan-glow"
              >
                <RadioGroupOption
                  value={value}
                  label={presetLabels[value]}
                  description={presetDescriptions[value]}
                />
              </div>
            ))}
          </div>
        </RadioGroup>

        {preset === "exploratory" && (
          <div className="relative mt-sm mb-md overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base px-md py-sm before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-amber before:to-transparent">
            <span className="mr-md font-mono text-[0.7rem] font-bold tracking-[0.06em] text-amber uppercase">
              Exploratory posture
            </span>
            <span className="font-mono text-[0.72rem] text-text-secondary">
              Nothing merges from this spec — completion claims and merges are
              refused while this preset is active.
            </span>
          </div>
        )}

        <div className="mt-sm overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface">
          {GATES.map((gate) => {
            const isOverride = overrides[gate] !== "inherit";
            const resolved = resolveDial(proposedPolicy, gate);
            const isCombined = resolved === COMBINED_APPROVAL_DIAL;
            const selectedDial = isCombined ? "gate" : resolved;
            const presetResolved = resolveDial({ preset }, gate);
            const presetDial =
              presetResolved === COMBINED_APPROVAL_DIAL
                ? "gate"
                : presetResolved;
            return (
              <section
                key={gate}
                className="grid grid-cols-[minmax(180px,1fr)_auto] items-center gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-[11px] last:border-b-0 max-768:grid-cols-1"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-sm">
                    <h2 className="m-0 font-mono text-[0.78rem] font-semibold text-text-primary">
                      {gateLabels[gate]}
                    </h2>
                    {isOverride ? (
                      <StatusChip tone="amber">Override</StatusChip>
                    ) : isCombined ? (
                      <StatusChip tone="neutral">
                        Combined at propose
                      </StatusChip>
                    ) : null}
                    {isOverride && (
                      <button
                        type="button"
                        disabled={pending}
                        title={`Reset to preset default (${presetDial})`}
                        onClick={() => {
                          const nextOverrides = {
                            ...overrides,
                            [gate]: "inherit" as const,
                          };
                          proposePolicy(
                            proposedGatePolicy(preset, nextOverrides),
                          );
                        }}
                        className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.64rem] text-text-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        ↺ preset
                      </button>
                    )}
                  </div>
                  <p className="mt-[2px] mb-0 font-mono text-[0.68rem] text-text-tertiary">
                    {gateDescriptions[gate]}
                  </p>
                </div>
                <SegmentedControl
                  aria-label={`${gateLabels[gate]} gate mode`}
                  value={selectedDial}
                  onValueChange={(value) => {
                    const nextDial = value as SpecGateDial;
                    const nextOverrides = {
                      ...overrides,
                      [gate]: nextDial === presetDial ? "inherit" : nextDial,
                    };
                    proposePolicy(proposedGatePolicy(preset, nextOverrides));
                  }}
                  disabled={pending}
                  layoutClassName="max-768:w-full max-768:overflow-x-auto"
                >
                  <SegmentedControlItem value="gate" disabled={isCombined}>
                    Gate
                  </SegmentedControlItem>
                  <SegmentedControlItem value="notify" disabled={isCombined}>
                    Notify
                  </SegmentedControlItem>
                  <SegmentedControlItem
                    value="off"
                    disabled={isCombined || gate === "delivery"}
                  >
                    Off
                  </SegmentedControlItem>
                </SegmentedControl>
                {gate === "delivery" && (
                  <p className="col-span-2 m-0 font-mono text-[0.68rem] text-text-tertiary max-768:col-span-1">
                    Delivery can never be Off.
                  </p>
                )}
              </section>
            );
          })}
        </div>

        <aside
          role="note"
          aria-label="Dial values"
          className="mt-md rounded-md border border-solid border-border-subtle bg-bg-surface px-md py-sm"
        >
          <p className="mt-0 mb-sm font-mono text-[0.62rem] font-bold tracking-[0.1em] text-text-tertiary uppercase">
            Dial values
          </p>
          <dl className="m-0 grid grid-cols-[56px_minmax(0,1fr)] gap-x-md gap-y-xs font-mono text-[0.7rem]">
            <dt className="font-bold text-text-primary">Gate</dt>
            <dd className="m-0 text-text-secondary">
              hard stop — human approval required
            </dd>
            <dt className="font-bold text-text-primary">Notify</dt>
            <dd className="m-0 text-text-secondary">
              agent proceeds; human notified; recorded as a policy admission
            </dd>
            <dt className="font-bold text-text-primary">Off</dt>
            <dd className="m-0 text-text-secondary">
              transition free — still recorded as a policy admission
            </dd>
          </dl>
          <p className="mt-sm mb-0 border-x-0 border-t border-b-0 border-solid border-border-dim pt-sm font-mono text-[0.68rem] text-amber-dim">
            Floor: executions always pin revision and scope · evidence is always
            collected · Delivery is never Off · waivers are never grantable by
            policy
          </p>
        </aside>

        {error !== null && (
          <FormError role="alert" layoutClassName="mt-md">
            {error}
          </FormError>
        )}
      </div>

      <AlertDialog
        open={confirmationPolicy !== null}
        onOpenChange={(open) => {
          if (open) return;
          if (confirmationAccepted.current) {
            confirmationAccepted.current = false;
            setConfirmationPolicy(null);
            return;
          }
          discardConfirmation();
        }}
      >
        <AlertDialogContent size="wide">
          <AlertDialogTitle>
            Gate policy change — human confirmation
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirmationLoosens
              ? "This policy change reduces at least one gate. Confirm that the agent may use the looser posture for future work."
              : "This policy change switches the preset without reducing any gate. Confirm the new posture for future work."}
          </AlertDialogDescription>
          {confirmationLoosens && (
            <p className="mt-md mb-0 rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm font-mono text-[0.7rem] text-amber">
              Loosening — at least one gate becomes weaker than it is today.
            </p>
          )}
          {confirmationPolicy !== null && (
            <PolicyImpactPreview
              currentPolicy={currentPolicy}
              proposedPolicy={confirmationPolicy}
              draft={openDraft}
            />
          )}
          <div className="my-md grid gap-xs rounded-md border border-solid border-border-subtle bg-bg-base px-md py-sm font-mono text-[0.7rem] text-text-secondary">
            <span>
              · applies prospectively only — nothing already admitted is
              retroactively approved
            </span>
            <span>· recorded with your identity as the confirming human</span>
            <span>
              · Delivery remains floored at Notify and waivers remain human-only
            </span>
          </div>
          <AlertDialogActions>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmPolicyChange} loading={pending}>
              Confirm policy change
            </AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export interface StartExecutionInput {
  revisionId: string;
  sessionName: string | null;
  scope: {
    selectedTaskIds: string[];
    selectedCriterionIds: string[];
    exclusionDispositions: Array<{
      criterionId: string;
      disposition: Exclude<SpecCriterionDisposition, "in_scope">;
    }>;
  };
}

interface GrantWaiverInput {
  criterionElementId: string;
  revisionId: string;
  reason: string;
}

interface SetDispositionInput {
  executionId: string;
  criterionElementId: string;
  disposition: SpecCriterionDisposition;
  waiverId?: string;
  deliveredByExecutionId?: string;
}

interface GrantGateApprovalPanelInput {
  executionId: string;
  revisionId: string;
}

interface ApproveExecutionStartPanelInput {
  executionId: string;
}

export interface CaptureDiscoveredWorkInput {
  executionId: string;
  discoveredTask: Omit<TaskElementPayload, "kind">;
  blockingReason?: string;
}

export interface AbandonExecutionPanelInput {
  executionId: string;
  reason: string;
}

export function ExecutionPanel({
  detail,
  projectName,
  pendingAction,
  error,
  onStart,
  onGrantWaiver,
  onSetDisposition,
  onGrantGateApproval,
  onApproveExecutionStart,
  onCaptureScopeAmendment,
  onAbandonExecution,
}: {
  detail: SpecDetailView;
  projectName: string;
  pendingAction: string | null;
  error: string | null;
  onStart(input: StartExecutionInput): void;
  onGrantWaiver(input: GrantWaiverInput): void;
  onSetDisposition(input: SetDispositionInput): void;
  onGrantGateApproval(input: GrantGateApprovalPanelInput): void;
  onApproveExecutionStart(input: ApproveExecutionStartPanelInput): void;
  onCaptureScopeAmendment(input: CaptureDiscoveredWorkInput): void;
  onAbandonExecution(input: AbandonExecutionPanelInput): void;
}): React.JSX.Element {
  const approvedSnapshot = approvedRevisionSnapshot(detail);
  const activeExecution = detail.executions.find(
    (execution) =>
      execution.state === "definition_review" || execution.state === "running",
  );
  const deliveryRequiresGateApproval =
    resolveDial(detail.spec.gatePolicy, "delivery") === "gate";
  const executionStartRequiresGateApproval =
    resolveDial(detail.spec.gatePolicy, "execution_start") === "gate";
  const gateAdmitted =
    (gate: "delivery" | "execution_start") => (execution: { id: string }) =>
      detail.gateAdmissions.some(
        (admission) =>
          admission.gate === gate && admission.executionId === execution.id,
      );
  const deliveryAdmitted = gateAdmitted("delivery");
  const executionStartAdmitted = gateAdmitted("execution_start");

  return (
    <section
      aria-label="Execution and merge"
      className="mx-auto max-w-[1080px] pb-[48px]"
    >
      <ExecutionWorkflowHeader
        specSlug={detail.spec.slug}
        execution={activeExecution}
      />

      {activeExecution !== undefined ? (
        <>
          {activeExecution.state === "definition_review" ? (
            <DefinitionReviewPanel
              detail={detail}
              projectName={projectName}
              execution={activeExecution}
              snapshot={snapshotForExecution(detail, activeExecution)}
              requiresApproval={executionStartRequiresGateApproval}
              admitted={executionStartAdmitted(activeExecution)}
              pending={pendingAction === "approve-execution-start"}
              onApprove={onApproveExecutionStart}
            />
          ) : (
            <div className="mb-md flex flex-wrap items-center justify-between gap-md rounded-md border border-solid border-[var(--cc-green-border)] bg-green-glow px-md py-sm">
              <div className="flex items-center gap-sm">
                <span
                  aria-hidden="true"
                  className="size-[7px] rounded-full bg-green shadow-[0_0_10px_var(--color-green)]"
                />
                <div>
                  <p className="m-0 font-mono text-[0.72rem] font-bold tracking-[0.05em] text-green uppercase">
                    Definition approved
                  </p>
                  <p className="mt-[2px] mb-0 font-mono text-[0.66rem] text-text-tertiary">
                    Contract provenance is locked for this running execution.
                  </p>
                </div>
              </div>
              <ExecutionLinks
                projectName={projectName}
                execution={activeExecution}
              />
            </div>
          )}

          <MergeGatePanel
            detail={detail}
            execution={activeExecution}
            snapshot={snapshotForExecution(detail, activeExecution)}
            deliveryRequiresGateApproval={deliveryRequiresGateApproval}
            deliveryAdmitted={deliveryAdmitted(activeExecution)}
            pendingAction={pendingAction}
            error={error}
            onGrantWaiver={onGrantWaiver}
            onSetDisposition={onSetDisposition}
            onGrantGateApproval={onGrantGateApproval}
          />

          {/* The service refuses capture for any non-running execution, so the
              control renders only for the state the server accepts. */}
          {activeExecution.state === "running" && (
            <CaptureDiscoveredWorkForm
              executionId={activeExecution.id}
              pending={pendingAction === "capture-scope-amendment"}
              onCapture={onCaptureScopeAmendment}
            />
          )}

          {/* The escape hatch stays reachable in every active state: an
              execution whose workflow stalled, halted, or was compiled from a
              superseded revision must be stoppable from here so a fresh run
              can start. */}
          <AbandonExecutionForm
            executionId={activeExecution.id}
            pending={pendingAction === "abandon-execution"}
            onAbandon={onAbandonExecution}
          />
        </>
      ) : approvedSnapshot === null ? (
        <section className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg">
          <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
            Start execution — scope selection
          </h2>
          <p className="mt-sm mb-0 text-[0.76rem] leading-relaxed text-text-secondary">
            Approve a revision before selecting an execution scope.
          </p>
        </section>
      ) : (
        <ExecutionScopeForm
          snapshot={approvedSnapshot}
          projectName={projectName}
          pending={pendingAction === "start-execution"}
          error={error}
          onStart={onStart}
        />
      )}
    </section>
  );
}

function ExecutionWorkflowHeader({
  specSlug,
  execution,
}: {
  specSlug: string;
  execution: SpecExecutionView | undefined;
}): React.JSX.Element {
  return (
    <header className="mb-md border-x-0 border-t-0 border-b border-solid border-border-dim pt-[10px] pb-[12px]">
      <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
        workflows /{" "}
        {execution === undefined ? specSlug : `${execution.id} — ${specSlug}`}
      </p>
      <div className="mt-xs flex flex-wrap items-end justify-between gap-sm">
        <div>
          <h2 className="m-0 font-display text-[1.05rem] font-bold text-text-primary">
            Execution — inside the workflow surface
          </h2>
          <p className="mt-[3px] mb-0 text-[0.72rem] leading-relaxed text-text-secondary">
            The approved plan compiles to a standard graph workflow; scope,
            provenance, and merge criteria stay visible here.
          </p>
        </div>
        {execution !== undefined && (
          <StatusChip
            tone={execution.state === "definition_review" ? "amber" : "cyan"}
          >
            {executionStateLabel(execution.state)}
          </StatusChip>
        )}
      </div>
    </header>
  );
}

function ExecutionLinks({
  projectName,
  execution,
}: {
  projectName: string;
  execution: SpecExecutionView;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-md">
      <Link
        href={`/projects/${encodeURIComponent(projectName)}/workflows?definition=${encodeURIComponent(execution.workflowDefinitionId)}`}
        className="font-mono text-[0.68rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
      >
        Open workflow definition
      </Link>
      {execution.workflowExecutionId !== null &&
        execution.sessionName !== null && (
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(execution.sessionName)}/workflow`}
            className="font-mono text-[0.68rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Open workflow run
          </Link>
        )}
    </div>
  );
}

function DefinitionReviewPanel({
  detail,
  projectName,
  execution,
  snapshot,
  requiresApproval,
  admitted,
  pending,
  onApprove,
}: {
  detail: SpecDetailView;
  projectName: string;
  execution: SpecExecutionView;
  snapshot: SpecRevisionSnapshot | null;
  requiresApproval: boolean;
  admitted: boolean;
  pending: boolean;
  onApprove(input: ApproveExecutionStartPanelInput): void;
}): React.JSX.Element {
  const tasks = (snapshot?.elements ?? []).filter(
    (entry) => entry.version.payload.kind === "task",
  );
  const revisionNumber = snapshot?.revision.number ?? "?";

  return (
    <section
      data-testid="definition-review-banner"
      className="relative mb-md overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface p-md before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-gradient-to-r before:from-amber before:via-amber before:to-transparent"
    >
      <div className="flex flex-wrap items-start justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
        <div className="flex min-w-0 items-start gap-sm">
          <span
            aria-hidden="true"
            className="mt-[5px] size-[8px] shrink-0 rounded-full bg-amber shadow-[0_0_10px_var(--color-amber)]"
          />
          <div>
            <h3 className="m-0 font-mono text-[0.78rem] font-bold tracking-[0.04em] text-amber uppercase">
              Definition awaiting approval
            </h3>
            <p className="mt-[3px] mb-0 text-[0.72rem] leading-relaxed text-text-secondary">
              Generated from native-sdd revision {revisionNumber}. Contract
              content is pinned; only execution settings remain adjustable.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-sm">
          <Link
            href={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`}
            className="rounded-md border border-solid border-border-default px-[12px] py-[6px] font-mono text-[0.72rem] font-medium text-text-secondary no-underline hover:border-border-strong hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Request changes
          </Link>
          {requiresApproval && !admitted && (
            <Button
              size="sm"
              variant="success"
              loading={pending}
              onClick={() => onApprove({ executionId: execution.id })}
            >
              Approve definition &amp; start
            </Button>
          )}
          {admitted && (
            <StatusChip tone="green">Execution start approved</StatusChip>
          )}
        </div>
      </div>

      <div className="mt-md grid grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)] gap-md max-768:grid-cols-1">
        <section
          aria-label="Contract-derived — provenance-locked"
          className="rounded-md border border-solid border-border-dim bg-bg-base p-md"
        >
          <h4 className="m-0 font-mono text-[0.68rem] font-bold tracking-[0.08em] text-text-secondary uppercase">
            Contract-derived — provenance-locked
          </h4>
          <div className="mt-sm grid gap-[6px]">
            {tasks.map((entry) => {
              if (entry.version.payload.kind !== "task") return null;
              const criteria = entry.version.payload.coveredCriterionElementIds
                .map((id) => criterionHandle(snapshot, id))
                .filter((handle): handle is string => handle !== null);
              return (
                <div
                  key={entry.element.id}
                  className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim py-[6px] last:border-b-0"
                >
                  <span className="font-mono text-[0.68rem] font-bold text-cyan">
                    T{entry.element.number ?? "?"}
                  </span>
                  <span className="truncate text-[0.72rem] text-text-primary">
                    {entry.version.payload.title}
                  </span>
                  <span className="font-mono text-[0.64rem] text-text-tertiary">
                    → {criteria.join(", ") || "no criteria"}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-sm mb-0 font-mono text-[0.64rem] text-text-tertiary">
            read-only · owned by {detail.spec.slug} rev {revisionNumber}
          </p>
        </section>

        <section
          aria-label="Execution-only — editable"
          className="rounded-md border border-solid border-border-dim bg-bg-base p-md"
        >
          <h4 className="m-0 font-mono text-[0.68rem] font-bold tracking-[0.08em] text-text-secondary uppercase">
            Execution-only — editable
          </h4>
          <dl className="mt-sm mb-0 grid gap-[6px]">
            {[
              ["Isolation", "Session worktree"],
              ["Validation", "Pre-merge checks"],
              ["Budgets", "Workflow defaults"],
            ].map(([term, value]) => (
              <div
                key={term}
                className="flex items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim py-[6px] last:border-b-0"
              >
                <dt className="font-mono text-[0.68rem] text-text-secondary">
                  {term}
                </dt>
                <dd className="m-0 font-mono text-[0.66rem] text-text-primary">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-sm">
            <ExecutionLinks projectName={projectName} execution={execution} />
          </div>
        </section>
      </div>

      {requiresApproval && admitted && (
        <p className="mt-md mb-0 font-mono text-[0.66rem] text-text-tertiary">
          A human approved this run&apos;s start. If the workflow hasn&apos;t
          begun, start it from the session — the approval stays recorded.
        </p>
      )}
      {requiresApproval && !admitted && (
        <p className="mt-md mb-0 font-mono text-[0.66rem] text-text-tertiary">
          The compiled definition won&apos;t run until a human approves this
          execution&apos;s start.
        </p>
      )}
    </section>
  );
}

function ExecutionScopeForm({
  snapshot,
  projectName,
  pending,
  error,
  onStart,
}: {
  snapshot: SpecRevisionSnapshot;
  projectName: string;
  pending: boolean;
  error: string | null;
  onStart(input: StartExecutionInput): void;
}): React.JSX.Element {
  const tasks = useMemo(
    () =>
      snapshot.elements.filter(
        (entry) => entry.version.payload.kind === "task",
      ),
    [snapshot],
  );
  const criteria = useMemo(
    () =>
      snapshot.elements.filter(
        (entry) => entry.version.payload.kind === "criterion",
      ),
    [snapshot],
  );
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>(() =>
    tasks.map((entry) => entry.element.id),
  );
  const [selectedCriterionIds, setSelectedCriterionIds] = useState<string[]>(
    () => criteria.map((entry) => entry.element.id),
  );
  const [sessionName, setSessionName] = useState("");
  const [exclusionDispositions, setExclusionDispositions] = useState<
    Record<string, Exclude<SpecCriterionDisposition, "in_scope"> | undefined>
  >({});

  function toggleSelection(
    id: string,
    selected: boolean,
    update: React.Dispatch<React.SetStateAction<string[]>>,
  ): void {
    update((current) =>
      selected
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((candidate) => candidate !== id),
    );
  }

  function handleStart(): void {
    if (validationIssues.length > 0) return;
    const selectedCriteria = new Set(selectedCriterionIds);
    const exclusions = criteria.flatMap((entry) => {
      if (selectedCriteria.has(entry.element.id)) return [];
      const disposition = exclusionDispositions[entry.element.id];
      return disposition === undefined
        ? []
        : [{ criterionId: entry.element.id, disposition }];
    });
    logger.info("spec_studio.execution_scope.start_requested", {
      revisionId: snapshot.revision.id,
      selectedTaskCount: selectedTaskIds.length,
      selectedCriterionCount: selectedCriterionIds.length,
      exclusionCount: exclusions.length,
    });
    onStart({
      revisionId: snapshot.revision.id,
      sessionName: sessionName.trim() || null,
      scope: {
        selectedTaskIds,
        selectedCriterionIds,
        exclusionDispositions: exclusions,
      },
    });
  }

  const selectedTasks = new Set(selectedTaskIds);
  const selectedCriteria = new Set(selectedCriterionIds);
  const excludedCriteria = criteria.filter(
    (entry) => !selectedCriteria.has(entry.element.id),
  );
  const validationIssues: string[] = [];
  if (selectedTaskIds.length === 0) validationIssues.push("Select a task");
  if (selectedCriterionIds.length === 0) {
    validationIssues.push("Select a criterion");
  }
  for (const entry of tasks) {
    if (
      !selectedTasks.has(entry.element.id) ||
      entry.version.payload.kind !== "task"
    ) {
      continue;
    }
    for (const dependencyId of entry.version.payload.dependsOnTaskElementIds) {
      if (selectedTasks.has(dependencyId)) continue;
      const dependency = tasks.find(
        (candidate) => candidate.element.id === dependencyId,
      );
      validationIssues.push(
        `T${entry.element.number ?? "?"} requires T${dependency?.element.number ?? "?"}`,
      );
    }
  }
  for (const criterion of criteria) {
    if (!selectedCriteria.has(criterion.element.id)) {
      if (exclusionDispositions[criterion.element.id] === undefined) {
        validationIssues.push(
          `${criterionHandle(snapshot, criterion.element.id) ?? "Criterion"} needs an exclusion disposition`,
        );
      }
      continue;
    }
    const covered = tasks.some(
      (task) =>
        selectedTasks.has(task.element.id) &&
        task.version.payload.kind === "task" &&
        task.version.payload.coveredCriterionElementIds.includes(
          criterion.element.id,
        ),
    );
    if (!covered) {
      validationIssues.push(
        `${criterionHandle(snapshot, criterion.element.id) ?? "Criterion"} has no selected task coverage`,
      );
    }
  }

  return (
    <section aria-labelledby="spec-execution-heading">
      <h2
        id="spec-execution-heading"
        className="m-0 font-display text-[0.92rem] font-bold text-text-primary"
      >
        Start execution — scope selection
      </h2>
      <p className="mt-xs mb-sm font-mono text-[0.66rem] leading-relaxed text-text-tertiary">
        Deterministic scope for {projectName}: dependencies must close, selected
        criteria need task coverage, and partial task selection is rejected.
      </p>
      <div className="rounded-lg border border-solid border-border-subtle bg-bg-surface px-md py-[14px]">
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-[6px] font-mono text-[0.64rem] font-bold tracking-[0.08em] text-text-tertiary uppercase">
            Tasks — dependency-closed selection
          </legend>
          <div className="flex flex-wrap gap-[6px]">
            {tasks.map((entry) => {
              const checked = selectedTaskIds.includes(entry.element.id);
              const title =
                entry.version.payload.kind === "task"
                  ? entry.version.payload.title
                  : "";
              return (
                <button
                  key={entry.element.id}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`T${entry.element.number ?? "?"} ${title}`}
                  title={title}
                  className={`inline-flex min-h-[26px] items-center gap-[6px] rounded-md border border-solid px-[9px] font-mono text-[0.68rem] transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px] ${
                    checked
                      ? "border-cyan-dim bg-cyan-glow text-cyan"
                      : "border-border-default bg-bg-base text-text-secondary hover:border-border-strong"
                  }`}
                  onClick={() =>
                    toggleSelection(
                      entry.element.id,
                      !checked,
                      setSelectedTaskIds,
                    )
                  }
                >
                  <span aria-hidden="true">{checked ? "✓" : "○"}</span>T
                  {entry.element.number ?? "?"}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="mt-md border-0 p-0">
          <legend className="mb-[6px] font-mono text-[0.64rem] font-bold tracking-[0.08em] text-text-tertiary uppercase">
            Criteria — exact delivery promise
          </legend>
          <div className="flex flex-wrap gap-[6px]">
            {criteria.map((entry) => {
              const handle =
                criterionHandle(snapshot, entry.element.id) ?? "Criterion";
              const checked = selectedCriterionIds.includes(entry.element.id);
              const criterionText =
                entry.version.payload.kind === "criterion"
                  ? entry.version.payload.text
                  : "";
              return (
                <button
                  key={entry.element.id}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`${handle} ${criterionText}`}
                  title={criterionText}
                  className={`inline-flex min-h-[26px] items-center gap-[6px] rounded-md border border-solid px-[9px] font-mono text-[0.68rem] transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px] ${
                    checked
                      ? "border-cyan-dim bg-cyan-glow text-cyan"
                      : "border-border-default bg-bg-base text-text-secondary hover:border-border-strong"
                  }`}
                  onClick={() =>
                    toggleSelection(
                      entry.element.id,
                      !checked,
                      setSelectedCriterionIds,
                    )
                  }
                >
                  <span aria-hidden="true">{checked ? "✓" : "○"}</span>
                  {handle}
                </button>
              );
            })}
          </div>
        </fieldset>

        {excludedCriteria.length > 0 && (
          <div className="mt-md border-x-0 border-t border-b-0 border-solid border-border-dim pt-md">
            <p className="m-0 font-mono text-[0.64rem] font-bold tracking-[0.08em] text-text-tertiary uppercase">
              Explicit exclusion dispositions
            </p>
            <div className="mt-[6px] grid gap-[6px]">
              {excludedCriteria.map((entry) => {
                const handle =
                  criterionHandle(snapshot, entry.element.id) ?? "Criterion";
                return (
                  <div
                    key={entry.element.id}
                    className="flex flex-wrap items-center justify-between gap-sm rounded-md border border-solid border-border-dim bg-bg-base px-sm py-[6px]"
                  >
                    <span className="font-mono text-[0.68rem] font-bold text-text-primary">
                      {handle}
                    </span>
                    <SegmentedControl
                      aria-label={`Exclusion disposition for ${handle}`}
                      value={exclusionDispositions[entry.element.id] ?? ""}
                      onValueChange={(value) =>
                        setExclusionDispositions((current) => ({
                          ...current,
                          [entry.element.id]: value as Exclude<
                            SpecCriterionDisposition,
                            "in_scope"
                          >,
                        }))
                      }
                    >
                      <SegmentedControlItem value="deferred">
                        Deferred
                      </SegmentedControlItem>
                      <SegmentedControlItem value="delivered_elsewhere">
                        Delivered elsewhere
                      </SegmentedControlItem>
                      <SegmentedControlItem value="waived" tone="violet">
                        Waived
                      </SegmentedControlItem>
                    </SegmentedControl>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-md flex flex-wrap items-end justify-between gap-md border-x-0 border-t border-b-0 border-solid border-border-dim pt-md">
          <div
            data-testid="execution-scope-validation"
            className="min-w-[240px] flex-1"
          >
            <p className="m-0 font-mono text-[0.66rem] text-text-secondary">
              {selectedTaskIds.length} tasks selected ·{" "}
              {selectedCriterionIds.length} criteria in scope ·{" "}
              {excludedCriteria.length} exclusions
            </p>
            {validationIssues.length > 0 && (
              <ul className="mt-[6px] mb-0 grid gap-[2px] rounded-md border border-solid border-[var(--cc-red-border)] bg-red-glow px-sm py-[6px] font-mono text-[0.64rem] text-red">
                {validationIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {error !== null && <FormError role="alert">{error}</FormError>}
          </div>
          <div className="flex flex-wrap items-end gap-md">
            <div className="w-[220px] max-768:w-full">
              <FormLabel htmlFor="spec-execution-session-name">
                Session name
              </FormLabel>
              <FormInput
                id="spec-execution-session-name"
                aria-label="Session name"
                value={sessionName}
                onChange={(event) => setSessionName(event.currentTarget.value)}
                placeholder="Optional session label"
              />
            </div>
            <Button
              variant="primary"
              loading={pending}
              disabled={validationIssues.length > 0}
              onClick={handleStart}
            >
              Start execution
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function MergeGatePanel({
  detail,
  execution,
  snapshot,
  deliveryRequiresGateApproval,
  deliveryAdmitted,
  pendingAction,
  error,
  onGrantWaiver,
  onSetDisposition,
  onGrantGateApproval,
}: {
  detail: SpecDetailView;
  execution: SpecExecutionView;
  snapshot: SpecRevisionSnapshot | null;
  deliveryRequiresGateApproval: boolean;
  deliveryAdmitted: boolean;
  pendingAction: string | null;
  error: string | null;
  onGrantWaiver(input: GrantWaiverInput): void;
  onSetDisposition(input: SetDispositionInput): void;
  onGrantGateApproval(input: GrantGateApprovalPanelInput): void;
}): React.JSX.Element {
  const selectedCriteria = selectedCriterionIds(execution.scope);
  const criteria = (snapshot?.elements ?? []).filter(
    (entry) => entry.version.payload.kind === "criterion",
  );
  const scopedCriteria = criteria.filter((entry) =>
    selectedCriteria.has(entry.element.id),
  );
  const excludedCriteria = criteria.filter(
    (entry) => !selectedCriteria.has(entry.element.id),
  );
  const dispositions = detail.criterionDispositions.filter(
    (row) => row.execution_id === execution.id,
  );
  const deliveredElsewhereCount = dispositions.filter(
    (row) =>
      selectedCriteria.has(row.criterion_element_id) &&
      row.disposition === "delivered_elsewhere",
  ).length;
  const projectionByCriterion = new Map(
    execution.deliveryProjection.map((row) => [row.criterionElementId, row]),
  );
  const proofRecordedOrBetter = execution.deliveryProjection.filter(
    (row) =>
      row.proofState === "proof_recorded" || row.proofState === "proven_merged",
  ).length;
  const projectionWaivedCount = execution.deliveryProjection.filter(
    (row) => row.proofState === "waived",
  ).length;
  const projectionDeliveredElsewhereCount = execution.deliveryProjection.filter(
    (row) => row.proofState === "delivered_elsewhere",
  ).length;

  return (
    // The ?el=delivery deep link resolves here: focusable so the retrying
    // scroll/focus effect actually lands (focus() is a no-op on a
    // non-focusable section).
    <section
      id="merge-gate"
      tabIndex={-1}
      aria-label={`Merge gate for ${execution.id}`}
      className="scroll-mt-lg overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <header className="flex flex-wrap items-start justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-raised px-md py-sm">
        <div>
          <h3 className="m-0 font-mono text-[0.76rem] font-bold tracking-[0.05em] text-text-primary uppercase">
            Merge gate — {execution.id} → main
          </h3>
          <p className="mt-[3px] mb-0 font-mono text-[0.65rem] text-text-tertiary">
            Scoped only to promised criteria; exclusions remain visible but do
            not block this delivery.
          </p>
        </div>
        <span className="font-mono text-[0.64rem] text-text-tertiary">
          revision {snapshot?.revision.number ?? "?"} pinned
        </span>
      </header>

      <div className="divide-y divide-border-dim">
        {scopedCriteria.map((entry) => {
          if (entry.version.payload.kind !== "criterion") return null;
          const handle = criterionHandle(snapshot, entry.element.id);
          if (handle === null) return null;
          const disposition = dispositions.find(
            (row) => row.criterion_element_id === entry.element.id,
          );
          const waiver = detail.waivers.find(
            (row) =>
              row.criterion_element_id === entry.element.id &&
              row.revision_id === execution.revisionId &&
              row.stale === 0,
          );
          const deliveredExecution =
            detail.executions.find(
              (candidate) =>
                candidate.id === disposition?.delivered_by_execution_id &&
                candidate.state === "delivered",
            ) ??
            detail.executions.find(
              (candidate) => candidate.state === "delivered",
            );
          return (
            <CriterionExecutionControls
              key={`${entry.element.id}:${disposition?.updated_at ?? "initial"}`}
              criterionElementId={entry.element.id}
              handle={handle}
              text={entry.version.payload.text}
              execution={execution}
              disposition={disposition}
              projection={projectionByCriterion.get(entry.element.id)}
              waiver={waiver}
              deliveredExecution={deliveredExecution}
              pendingAction={pendingAction}
              onGrantWaiver={onGrantWaiver}
              onSetDisposition={onSetDisposition}
            />
          );
        })}
      </div>

      {(excludedCriteria.length > 0 || deliveredElsewhereCount > 0) && (
        <div className="mx-md mt-md rounded-md border border-dashed border-border-default bg-bg-base px-md py-sm">
          <p className="m-0 font-mono text-[0.65rem] font-bold tracking-[0.05em] text-text-secondary uppercase">
            Non-blocking outcomes
          </p>
          <div className="mt-[6px] flex flex-wrap items-center gap-sm font-mono text-[0.64rem] text-text-tertiary">
            {excludedCriteria.length > 0 && (
              <span>
                {excludedCriteria.length} deferred criterion
                {excludedCriteria.length === 1 ? "" : "s"}:{" "}
                {excludedCriteria
                  .map((entry) => criterionHandle(snapshot, entry.element.id))
                  .filter((handle): handle is string => handle !== null)
                  .map((handle) => (
                    <span
                      key={handle}
                      className="ml-[4px] font-bold text-text-secondary"
                    >
                      {handle}
                    </span>
                  ))}
              </span>
            )}
            {deliveredElsewhereCount > 0 && (
              <span>
                · {deliveredElsewhereCount} delivered elsewhere · proof belongs
                to the linked execution
              </span>
            )}
          </div>
        </div>
      )}

      <div className="m-md flex flex-wrap items-center justify-between gap-md border-x-0 border-t border-b-0 border-solid border-border-dim pt-md">
        <div>
          <p className="m-0 font-mono text-[0.7rem] font-bold text-text-primary">
            {proofRecordedOrBetter}/{scopedCriteria.length} proof recorded ·{" "}
            {projectionWaivedCount} waived · {projectionDeliveredElsewhereCount}{" "}
            external delivery
          </p>
          <p className="mt-[3px] mb-0 font-mono text-[0.64rem] text-text-tertiary">
            Criteria count as proven once a gate-passed merge publishes — merged
            proof {detail.status.delivery.provenCount}/
            {detail.status.delivery.totalInScope}.
          </p>
        </div>

        {deliveryRequiresGateApproval ? (
          deliveryAdmitted ? (
            <div className="flex max-w-[520px] flex-wrap items-center justify-end gap-sm">
              <StatusChip tone="green">Delivery approved</StatusChip>
              <p className="m-0 font-mono text-[0.63rem] text-text-tertiary">
                The merge still needs valid proof or a waiver for every in-scope
                criterion before the gate admits it.
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-sm">
              <p className="m-0 max-w-[360px] font-mono text-[0.63rem] text-text-tertiary">
                The delivery gate refuses this run&apos;s merge until a human
                approves delivery.
              </p>
              <Button
                size="sm"
                variant="success"
                loading={pendingAction === "grant-gate-approval"}
                onClick={() =>
                  onGrantGateApproval({
                    executionId: execution.id,
                    revisionId: execution.revisionId,
                  })
                }
              >
                Approve delivery for merge
              </Button>
            </div>
          )
        ) : (
          <StatusChip tone="neutral">Delivery admitted by policy</StatusChip>
        )}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mx-md mt-0 mb-md font-mono text-[0.68rem] text-red"
        >
          {error}
        </p>
      )}
    </section>
  );
}

function CaptureDiscoveredWorkForm({
  executionId,
  pending,
  onCapture,
}: {
  executionId: string;
  pending: boolean;
  onCapture(input: CaptureDiscoveredWorkInput): void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [blockingReason, setBlockingReason] = useState("");
  const canCapture =
    title.trim().length > 0 &&
    instructions.trim().length > 0 &&
    (!blocking || blockingReason.trim().length > 0);

  function handleCapture(): void {
    onCapture({
      executionId,
      discoveredTask: {
        title: title.trim(),
        instructions: instructions.trim(),
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      ...(blocking ? { blockingReason: blockingReason.trim() } : {}),
    });
  }

  return (
    <div className="mt-md rounded-md border border-solid border-border-dim bg-bg-base p-md">
      <h3 className="m-0 font-display text-[0.8rem] font-bold text-text-primary">
        Capture discovered work
      </h3>
      <p className="mt-xs mb-0 text-[0.72rem] leading-relaxed text-text-secondary">
        This run&apos;s pinned scope never changes. Captured work becomes a task
        on a draft amendment revision and queues for a future execution.
      </p>
      <FormGroup layoutClassName="mt-md">
        <FormLabel htmlFor="spec-capture-title">Task title</FormLabel>
        <FormInput
          id="spec-capture-title"
          aria-label="Discovered task title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          autoComplete="off"
        />
      </FormGroup>
      <FormGroup layoutClassName="mt-sm">
        <FormLabel htmlFor="spec-capture-instructions">Instructions</FormLabel>
        <FormInput
          id="spec-capture-instructions"
          aria-label="Discovered task instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          autoComplete="off"
        />
      </FormGroup>
      <div className="mt-sm">
        <CheckboxField
          checked={blocking}
          onCheckedChange={(checked) => setBlocking(checked === true)}
          label="Blocks this run — abandon and restart"
        />
      </div>
      {blocking && (
        <FormGroup layoutClassName="mt-sm">
          <FormLabel htmlFor="spec-capture-blocking-reason">
            Blocking reason
          </FormLabel>
          <FormInput
            id="spec-capture-blocking-reason"
            aria-label="Blocking reason"
            value={blockingReason}
            onChange={(event) => setBlockingReason(event.currentTarget.value)}
            placeholder="Required durable abandonment reason"
          />
          <FormHint>
            Capturing with a blocking reason abandons this running execution.
            Restart from the amended revision once it is approved.
          </FormHint>
        </FormGroup>
      )}
      <Button
        size="sm"
        layoutClassName="mt-md"
        loading={pending}
        disabled={!canCapture}
        onClick={handleCapture}
      >
        Capture discovered work
      </Button>
    </div>
  );
}

function AbandonExecutionForm({
  executionId,
  pending,
  onAbandon,
}: {
  executionId: string;
  pending: boolean;
  onAbandon(input: AbandonExecutionPanelInput): void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");

  return (
    <div className="mt-md rounded-md border border-solid border-[var(--cc-red-border)] bg-bg-base p-md">
      <h3 className="m-0 font-display text-[0.8rem] font-bold text-text-primary">
        Abandon execution
      </h3>
      <p className="mt-xs mb-0 text-[0.72rem] leading-relaxed text-text-secondary">
        Abandonment is terminal for this run: its pinned revision and scope are
        retained as history, and a new execution can start from any approved
        revision.
      </p>
      <FormGroup layoutClassName="mt-md">
        <FormLabel htmlFor="spec-abandon-execution-reason">
          Abandonment reason
        </FormLabel>
        <FormInput
          id="spec-abandon-execution-reason"
          aria-label="Abandonment reason"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          placeholder="Required durable abandonment reason"
          autoComplete="off"
        />
      </FormGroup>
      <Button
        size="sm"
        variant="danger"
        layoutClassName="mt-md"
        loading={pending}
        disabled={reason.trim().length === 0}
        onClick={() => onAbandon({ executionId, reason: reason.trim() })}
      >
        Abandon execution
      </Button>
    </div>
  );
}

export interface AbandonSpecPanelInput {
  reason: string;
}

/**
 * Whole-spec abandonment. The transport gate refuses this action for agents,
 * so this control is the only surface that can reach it — and it is
 * deliberately kept apart from `AbandonExecutionForm`: that one stops a single
 * run, this one retires the durable spec every run belongs to.
 */
export function AbandonSpecPanel({
  slug,
  abandonedAt,
  abandonedReason,
  pending,
  error,
  onAbandonSpec,
}: {
  slug: string;
  abandonedAt: string | null;
  abandonedReason: string | null;
  pending: boolean;
  error: string | null;
  onAbandonSpec(input: AbandonSpecPanelInput): void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const trimmedReason = reason.trim();

  function handleOpenChange(open: boolean): void {
    setConfirming(open);
    setReason("");
  }

  // The only site allowed to abandon the spec: a human confirmed it here. No
  // predicate and no fall-through path may reach `onAbandonSpec`.
  function confirmAbandonSpec(): void {
    if (trimmedReason.length === 0) return;
    logger.info("spec_studio.abandon_spec.confirmed", { slug });
    onAbandonSpec({ reason: trimmedReason });
  }

  if (abandonedAt !== null) {
    return (
      <section
        aria-label="Spec lifecycle"
        className="mt-xl rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
      >
        <div className="flex flex-wrap items-center gap-sm">
          <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
            Spec abandoned
          </h2>
          <StatusChip tone="red">Retired</StatusChip>
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {abandonedAt}
          </span>
        </div>
        <p className="mt-sm mb-0 max-w-[680px] text-[0.76rem] leading-relaxed text-text-secondary">
          {abandonedReason ?? "No reason was recorded."}
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Spec lifecycle"
      className="mt-xl rounded-lg border border-solid border-red-dim bg-red-glow p-lg"
    >
      <div className="flex flex-wrap items-center gap-sm">
        <h2 className="m-0 font-display text-[0.92rem] font-bold text-red">
          Abandon this spec
        </h2>
        <StatusChip tone="red">Terminal</StatusChip>
      </div>
      <p className="mt-sm mb-0 max-w-[680px] text-[0.76rem] leading-relaxed text-text-secondary">
        This retires the whole spec, not a run: it leaves the active inventory,
        no further execution can start from it, and its revisions stay readable
        as history. To stop one run and start another, use Abandon execution on
        the execution surface above.
      </p>
      {error !== null && (
        <FormError role="alert" layoutClassName="mt-md">
          {error}
        </FormError>
      )}
      <AlertDialog open={confirming} onOpenChange={handleOpenChange}>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="danger"
            layoutClassName="mt-md"
            loading={pending}
          >
            Abandon whole spec
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent size="default">
          <AlertDialogTitle>Abandon spec {slug}?</AlertDialogTitle>
          <AlertDialogDescription>
            {slug} stops being an active spec. Its approved revisions, evidence,
            and executions remain readable, but nothing new can be proposed,
            started, or delivered from it. Studio cannot undo this.
          </AlertDialogDescription>
          <FormGroup layoutClassName="mt-lg mb-sm">
            <FormLabel htmlFor="spec-abandon-spec-reason">
              Spec abandonment reason
            </FormLabel>
            <FormInput
              id="spec-abandon-spec-reason"
              aria-label="Spec abandonment reason"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder="Required durable reason, kept with the spec"
              autoComplete="off"
            />
          </FormGroup>
          <AlertDialogActions>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              danger
              onClick={confirmAbandonSpec}
              loading={pending}
              disabled={trimmedReason.length === 0}
            >
              Abandon spec permanently
            </AlertDialogAction>
          </AlertDialogActions>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CriterionExecutionControls({
  criterionElementId,
  handle,
  text,
  execution,
  disposition,
  projection,
  waiver,
  deliveredExecution,
  pendingAction,
  onGrantWaiver,
  onSetDisposition,
}: {
  criterionElementId: string;
  handle: string;
  text: string;
  execution: SpecExecutionView;
  disposition: SpecCriterionDispositionRow | undefined;
  projection: CriterionDeliveryProjection | undefined;
  waiver: SpecWaiverRow | undefined;
  deliveredExecution: SpecExecutionView | undefined;
  pendingAction: string | null;
  onGrantWaiver(input: GrantWaiverInput): void;
  onSetDisposition(input: SetDispositionInput): void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [selectedDisposition, setSelectedDisposition] = useState<
    "" | "waived" | "delivered_elsewhere"
  >("");

  const canSaveDisposition =
    selectedDisposition !== "" &&
    (selectedDisposition !== "waived" || waiver !== undefined) &&
    (selectedDisposition !== "delivered_elsewhere" ||
      deliveredExecution !== undefined);

  function saveDisposition(): void {
    if (selectedDisposition === "") return;
    const input: SetDispositionInput = {
      executionId: execution.id,
      criterionElementId,
      disposition: selectedDisposition,
    };
    if (selectedDisposition === "waived" && waiver !== undefined) {
      input.waiverId = waiver.id;
    }
    if (
      selectedDisposition === "delivered_elsewhere" &&
      deliveredExecution !== undefined
    ) {
      input.deliveredByExecutionId = deliveredExecution.id;
    }
    onSetDisposition(input);
  }

  return (
    <article className="bg-bg-base px-md py-sm">
      <div className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-sm max-768:grid-cols-[42px_minmax(0,1fr)]">
        <span className="font-mono text-[0.7rem] font-bold text-cyan">
          {handle}
        </span>
        <p
          className="m-0 truncate text-[0.7rem] text-text-secondary"
          title={text}
        >
          {text}
        </p>
        <span className="inline-flex flex-wrap items-center justify-end gap-[6px]">
          {projection?.strategyKinds.map((kind) => (
            <span
              key={kind}
              className="inline-flex items-center rounded-full border border-solid border-border-subtle px-[7px] py-[1px] font-mono text-[0.6rem] tracking-[0.04em] text-text-tertiary uppercase"
            >
              {formatEvidenceKind(kind)}
            </span>
          ))}
          {projection !== undefined && (
            <StatusChip
              tone={proofStatePresentation[projection.proofState].tone}
            >
              {proofStatePresentation[projection.proofState].label}
            </StatusChip>
          )}
          <StatusChip
            tone={disposition?.disposition === "waived" ? "amber" : "neutral"}
          >
            {dispositionLabels[disposition?.disposition ?? "in_scope"]}
          </StatusChip>
        </span>
      </div>
      <div className="mt-[6px] flex flex-wrap items-center justify-end gap-[6px]">
        <Select
          value={selectedDisposition}
          onValueChange={(value) =>
            setSelectedDisposition(value as "waived" | "delivered_elsewhere")
          }
        >
          <SelectTrigger
            aria-label={`Disposition for ${handle}`}
            layoutClassName="w-[170px] max-768:w-full"
          >
            <SelectValue placeholder="Set outcome" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="waived" disabled={waiver === undefined}>
              Waived
            </SelectItem>
            <SelectItem
              value="delivered_elsewhere"
              disabled={deliveredExecution === undefined}
            >
              Delivered elsewhere
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          loading={pendingAction === "set-disposition"}
          disabled={!canSaveDisposition}
          aria-label={`Save disposition for ${handle}`}
          onClick={saveDisposition}
        >
          Save outcome
        </Button>
        {waiver === undefined && !waiverOpen && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Waive ${handle}`}
            onClick={() => setWaiverOpen(true)}
          >
            Waive…
          </Button>
        )}
      </div>

      {waiverOpen && waiver === undefined && (
        <div className="mt-sm flex flex-wrap items-end justify-end gap-sm rounded-md border border-solid border-[var(--cc-amber-border)] bg-amber-glow p-sm">
          <FormGroup layoutClassName="mb-0 min-w-[280px] flex-1">
            <FormLabel htmlFor={`waiver-reason-${criterionElementId}`}>
              Human waiver reason
            </FormLabel>
            <FormInput
              id={`waiver-reason-${criterionElementId}`}
              aria-label={`Waiver reason for ${handle}`}
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder="Required human rationale"
            />
          </FormGroup>
          <Button
            size="sm"
            variant="success"
            loading={pendingAction === "grant-waiver"}
            disabled={reason.trim().length === 0}
            aria-label={`Record waiver for ${handle}`}
            onClick={() =>
              onGrantWaiver({
                criterionElementId,
                revisionId: execution.revisionId,
                reason: reason.trim(),
              })
            }
          >
            Record waiver
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setWaiverOpen(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {waiver !== undefined && (
        <p className="mt-[6px] mb-0 text-right font-mono text-[0.62rem] text-amber">
          Human waiver recorded · {waiver.reason}
        </p>
      )}
    </article>
  );
}

/**
 * R11.2 post-hoc review surface: transitions the policy admitted under a
 * Notify (or Off) dial proceeded without a human approval, so Studio lists
 * them for review. Correction happens through the operations already on this
 * surface — request changes, an amendment, or abandoning the spec.
 */
export function PolicyAdmissionNotices({
  admissions,
}: {
  admissions: SpecGateAdmissionView[];
}): React.JSX.Element | null {
  const policyAdmissions = admissions.filter(
    (admission) =>
      admission.basis === "notify_policy" || admission.basis === "off_policy",
  );
  if (policyAdmissions.length === 0) return null;

  return (
    <section
      aria-label="Policy-admitted gates"
      className="mb-lg rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
    >
      <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
        Policy-admitted gates
      </h2>
      <p className="mt-xs mb-0 text-[0.74rem] leading-relaxed text-text-secondary">
        These transitions proceeded under the gate policy without a human
        approval. Review them; correct course with request changes, an
        amendment, or abandoning the spec.
      </p>
      <ul className="m-0 mt-md grid list-none gap-sm p-0">
        {policyAdmissions.map((admission) => (
          <li
            key={admission.id}
            className="flex flex-wrap items-center gap-md rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm"
          >
            <StatusChip
              tone={admission.basis === "notify_policy" ? "amber" : "neutral"}
            >
              {admission.basis === "notify_policy"
                ? "Proceeded under Notify"
                : "Proceeded with gate off"}
            </StatusChip>
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              {gateLabels[admission.gate]} gate · {admission.createdAt}
              {admission.revisionId !== null &&
                ` · revision ${admission.revisionId}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function IntegrityBanner({
  report,
  isPending,
  error,
}: {
  report: IntegrityReport | null;
  isPending: boolean;
  error: string | null;
}): React.JSX.Element | null {
  if (error !== null) {
    return (
      <div
        role="alert"
        className="mb-lg rounded-lg border border-solid border-red-dim bg-red-glow p-md text-red"
      >
        <strong className="font-display text-[0.86rem]">
          Integrity verification failed
        </strong>
        <p className="mt-xs mb-0 font-mono text-[0.7rem]">{error}</p>
      </div>
    );
  }
  if (isPending || report === null) return null;

  if (report.ok) {
    const revisionCount = report.checkedRevisionIds.length;
    return (
      <div
        role="status"
        className="mb-lg flex flex-wrap items-center justify-between gap-sm rounded-lg border border-solid border-green-dim bg-green-glow px-md py-sm text-green"
      >
        <strong className="font-display text-[0.82rem]">
          Integrity intact
        </strong>
        <span className="font-mono text-[0.7rem]">
          {revisionCount} approved{" "}
          {revisionCount === 1 ? "revision" : "revisions"} verified
        </span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="mb-lg rounded-lg border border-solid border-red-dim bg-red-glow p-md text-red"
    >
      <strong className="font-display text-[0.86rem]">
        Integrity mismatch
      </strong>
      <p className="mt-xs mb-sm text-[0.74rem] leading-relaxed">
        Stored revision content does not match its immutable approved hashes.
        Resolve the mismatch before relying on execution or delivery state.
      </p>
      <ul className="m-0 grid gap-xs pl-lg font-mono text-[0.68rem]">
        {report.mismatches.map((mismatch) => (
          <li key={mismatch.revisionId}>
            Revision {mismatch.revisionId}
            {mismatch.mismatchedElementIds.length > 0
              ? ` — elements ${mismatch.mismatchedElementIds.join(", ")}`
              : " — content hash mismatch"}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpecIntegrityPanel({
  detail,
  projectName,
}: {
  detail: SpecDetailView;
  projectName: string;
}): React.JSX.Element {
  const verify = useSpecIntegrityQuery(projectName, detail.spec.slug);
  const report = verify.data ?? null;
  const error = verify.error instanceof Error ? verify.error.message : null;

  useEffect(() => {
    if (report !== null && !report.ok) {
      logger.error("spec_studio.integrity.mismatch", {
        specId: detail.spec.id,
        mismatchCount: report.mismatches.length,
      });
    }
    if (error !== null) {
      logger.warn("spec_studio.integrity.verify_failed", {
        specId: detail.spec.id,
        error,
      });
    }
  }, [detail.spec.id, error, report]);

  return (
    <IntegrityBanner
      report={report}
      isPending={verify.isPending}
      error={error}
    />
  );
}

const startExecutionResponseSchema = z
  .object({
    execution: specStartedExecutionViewSchema,
    definition: workflowDefinitionRecordSchema,
  })
  .strict();

const captureScopeAmendmentResponseSchema = z
  .object({
    revision: specRevisionSchema,
    task: z
      .object({ element: specElementSchema, version: specElementVersionSchema })
      .strict(),
    restartRequired: z.boolean(),
  })
  .strict();

export default function SpecControlsPanel({
  detail,
  projectName,
}: {
  detail: SpecDetailView;
  projectName: string;
}): React.JSX.Element {
  const [actionFailure, setActionFailure] = useState<{
    action: string;
    message: string;
  } | null>(null);
  // change-policy answers with the spec *and* what the open draft still owes
  // under the confirmed dials, so a spec-only schema would reject every
  // accepted change as a parse failure.
  const changePolicy = useSpecActionMutation<
    { proposedPolicy: SpecGatePolicy; hardConfirmed: boolean },
    z.infer<typeof specPolicyChangeResultSchema>
  >(
    projectName,
    detail.spec.slug,
    "change-policy",
    specPolicyChangeResultSchema,
  );
  const startExecution = useSpecActionMutation<
    StartExecutionInput,
    z.infer<typeof startExecutionResponseSchema>
  >(
    projectName,
    detail.spec.slug,
    "start-execution",
    startExecutionResponseSchema,
  );
  const grantWaiver = useSpecActionMutation<
    GrantWaiverInput,
    z.infer<typeof specWaiverRowSchema>
  >(projectName, detail.spec.slug, "grant-waiver", specWaiverRowSchema);
  const setDisposition = useSpecActionMutation<
    SetDispositionInput,
    z.infer<typeof specCriterionDispositionRowSchema>
  >(
    projectName,
    detail.spec.slug,
    "set-disposition",
    specCriterionDispositionRowSchema,
  );
  const grantGateApproval = useSpecActionMutation<
    GrantGateApprovalPanelInput & { gate: "delivery" },
    z.infer<typeof specApprovalRowSchema>
  >(
    projectName,
    detail.spec.slug,
    "grant-gate-approval",
    specApprovalRowSchema,
  );
  const approveExecutionStart = useSpecActionMutation<
    ApproveExecutionStartPanelInput,
    z.infer<typeof specExecutionRowSchema>
  >(
    projectName,
    detail.spec.slug,
    "approve-execution-start",
    specExecutionRowSchema,
  );
  const captureScopeAmendment = useSpecActionMutation<
    CaptureDiscoveredWorkInput,
    z.infer<typeof captureScopeAmendmentResponseSchema>
  >(
    projectName,
    detail.spec.slug,
    "capture-scope-amendment",
    captureScopeAmendmentResponseSchema,
  );
  const abandonExecution = useSpecActionMutation<
    AbandonExecutionPanelInput,
    z.infer<typeof specExecutionRowSchema>
  >(projectName, detail.spec.slug, "abandon-execution", specExecutionRowSchema);
  const abandonSpec = useSpecActionMutation<
    AbandonSpecPanelInput,
    z.infer<typeof specSchema>
  >(projectName, detail.spec.slug, "abandon-spec", specSchema);
  const renameSpec = useSpecActionMutation<
    { slug: string; name?: string },
    RenameSpecResultView
  >(projectName, detail.spec.slug, "rename", renameSpecResultSchema);
  function mutationCallbacks(action: string) {
    return {
      onSuccess: () => {
        setActionFailure(null);
        logger.info("spec_studio.control_action.completed", {
          action,
          specId: detail.spec.id,
        });
      },
      onError: (mutationError: Error) => {
        setActionFailure({ action, message: mutationError.message });
        logger.warn("spec_studio.control_action.failed", {
          action,
          specId: detail.spec.id,
          error: mutationError.message,
        });
      },
    };
  }

  const pendingAction = changePolicy.isPending
    ? "change-policy"
    : startExecution.isPending
      ? "start-execution"
      : grantWaiver.isPending
        ? "grant-waiver"
        : setDisposition.isPending
          ? "set-disposition"
          : grantGateApproval.isPending
            ? "grant-gate-approval"
            : approveExecutionStart.isPending
              ? "approve-execution-start"
              : captureScopeAmendment.isPending
                ? "capture-scope-amendment"
                : abandonExecution.isPending
                  ? "abandon-execution"
                  : null;

  return (
    <div>
      <SpecIntegrityPanel detail={detail} projectName={projectName} />
      <PolicyAdmissionNotices admissions={detail.gateAdmissions} />
      <section
        aria-labelledby="spec-identity-heading"
        className="mb-xl flex items-baseline justify-between gap-md"
      >
        <div>
          <h2
            id="spec-identity-heading"
            className="m-0 font-display text-[0.95rem] font-extrabold text-text-primary"
          >
            Identity
          </h2>
          <p className="mt-[2px] mb-0 font-mono text-[0.72rem] text-text-tertiary">
            {detail.spec.slug}
          </p>
        </div>
        <RenameSpecDialog
          currentSlug={detail.spec.slug}
          currentName={detail.spec.name}
          pending={renameSpec.isPending}
          error={
            actionFailure?.action === "rename" ? actionFailure.message : null
          }
          onRename={(input) =>
            renameSpec.mutate(input, mutationCallbacks("rename"))
          }
        />
      </section>
      <div id="gate-policy" className="mb-xl scroll-mt-lg">
        <PolicyDialog
          currentPolicy={detail.spec.gatePolicy}
          pending={changePolicy.isPending}
          error={
            actionFailure?.action === "change-policy"
              ? actionFailure.message
              : null
          }
          onChangePolicy={(input) =>
            changePolicy.mutate(input, mutationCallbacks("change-policy"))
          }
          specSlug={detail.spec.slug}
          backHref={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`}
          openDraft={openDraftForPolicyImpact(detail)}
        />
      </div>
      <ExecutionPanel
        detail={detail}
        projectName={projectName}
        pendingAction={pendingAction}
        error={
          actionFailure !== null &&
          actionFailure.action !== "change-policy" &&
          actionFailure.action !== "abandon-spec" &&
          actionFailure.action !== "rename"
            ? actionFailure.message
            : null
        }
        onStart={(input) =>
          startExecution.mutate(input, mutationCallbacks("start-execution"))
        }
        onGrantWaiver={(input) =>
          grantWaiver.mutate(input, mutationCallbacks("grant-waiver"))
        }
        onSetDisposition={(input) =>
          setDisposition.mutate(input, mutationCallbacks("set-disposition"))
        }
        onGrantGateApproval={(input) =>
          grantGateApproval.mutate(
            { ...input, gate: "delivery" },
            mutationCallbacks("grant-gate-approval"),
          )
        }
        onApproveExecutionStart={(input) =>
          approveExecutionStart.mutate(
            input,
            mutationCallbacks("approve-execution-start"),
          )
        }
        onCaptureScopeAmendment={(input) =>
          captureScopeAmendment.mutate(
            input,
            mutationCallbacks("capture-scope-amendment"),
          )
        }
        onAbandonExecution={(input) =>
          abandonExecution.mutate(input, mutationCallbacks("abandon-execution"))
        }
      />
      <AbandonSpecPanel
        slug={detail.spec.slug}
        abandonedAt={detail.spec.abandonedAt}
        abandonedReason={detail.spec.abandonedReason}
        pending={abandonSpec.isPending}
        error={
          actionFailure?.action === "abandon-spec"
            ? actionFailure.message
            : null
        }
        onAbandonSpec={(input) =>
          abandonSpec.mutate(input, mutationCallbacks("abandon-spec"))
        }
      />
    </div>
  );
}

function policyOverrides(
  policy: SpecGatePolicy,
): Record<SpecGate, GateSelection> {
  return Object.fromEntries(
    GATES.map((gate) => [gate, policy.overrides?.[gate] ?? "inherit"]),
  ) as Record<SpecGate, GateSelection>;
}

function proposedGatePolicy(
  preset: SpecGatePreset,
  selections: Record<SpecGate, GateSelection>,
): SpecGatePolicy {
  const overrides = Object.fromEntries(
    GATES.flatMap((gate) =>
      selections[gate] === "inherit" ? [] : [[gate, selections[gate]]],
    ),
  ) as Partial<Record<SpecGate, SpecGateDial>>;
  return Object.keys(overrides).length === 0
    ? specGatePolicySchema.parse({ preset })
    : specGatePolicySchema.parse({ preset, overrides });
}

function policyChoiceLoosens(
  currentPolicy: SpecGatePolicy,
  proposedPolicy: SpecGatePolicy,
): boolean {
  return GATES.some(
    (gate) =>
      gateDialStrength(resolveDial(proposedPolicy, gate)) <
      gateDialStrength(resolveDial(currentPolicy, gate)),
  );
}

function gateDialStrength(
  dial: SpecGateDial | typeof COMBINED_APPROVAL_DIAL,
): number {
  switch (dial) {
    case "off":
      return 0;
    case "notify":
      return 1;
    case "gate":
    case COMBINED_APPROVAL_DIAL:
      return 2;
  }
}

function approvedRevisionSnapshot(
  detail: SpecDetailView,
): SpecRevisionSnapshot | null {
  return detail.currentApprovedRevision?.revision.state === "approved"
    ? detail.currentApprovedRevision
    : null;
}

function snapshotForExecution(
  detail: SpecDetailView,
  execution: SpecExecutionView,
): SpecRevisionSnapshot | null {
  return (
    [
      detail.currentRevision,
      detail.baseRevision,
      detail.currentApprovedRevision,
      ...detail.executionRevisionSnapshots,
    ].find((snapshot) => snapshot?.revision.id === execution.revisionId) ?? null
  );
}

/**
 * An unreadable stored scope arrives as a null `scope`, which is a different
 * claim than an empty scope: nothing is treated as promised, so no criterion
 * is shown in scope.
 */
function selectedCriterionIds(
  scope: SpecExecutionView["scope"],
): ReadonlySet<string> {
  return new Set(scope === null ? [] : scope.selectedCriterionIds);
}

function criterionHandle(
  snapshot: SpecRevisionSnapshot | null,
  criterionElementId: string,
): string | null {
  if (snapshot === null) return null;
  const criterion = snapshot.elements.find(
    (entry) => entry.element.id === criterionElementId,
  );
  if (
    criterion === undefined ||
    criterion.version.payload.kind !== "criterion" ||
    criterion.element.number === null ||
    criterion.element.parentElementId === null
  ) {
    return null;
  }
  const requirement = snapshot.elements.find(
    (entry) => entry.element.id === criterion.element.parentElementId,
  );
  if (
    requirement === undefined ||
    requirement.version.payload.kind !== "requirement" ||
    requirement.element.number === null
  ) {
    return null;
  }
  return `R${requirement.element.number}.${criterion.element.number}`;
}

function executionStateLabel(state: SpecExecutionView["state"]): string {
  switch (state) {
    case "definition_review":
      return "Definition review";
    case "running":
      return "Running";
    case "delivered":
      return "Delivered";
    case "abandoned":
      return "Abandoned";
  }
}
