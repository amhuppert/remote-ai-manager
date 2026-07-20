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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import { specSlugSchema } from "@/lib/specs/handles";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import {
  policyChangeRequiresHardConfirmation,
  resolveDial,
} from "@/lib/specs/policy";
import type { SpecDetailView } from "@/lib/specs/queries";
import { executionScopeSchema } from "@/lib/specs/scope-validation";
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
  type SpecExecutionRow,
  type SpecGate,
  type SpecGateAdmissionRow,
  type SpecGateDial,
  type SpecGatePolicy,
  type SpecGatePreset,
  type SpecRevisionSnapshot,
  type SpecWaiverRow,
  type TaskElementPayload,
} from "@/lib/specs/schemas";
import { workflowDefinitionRecordSchema } from "@/lib/workflow-graph/definition-schemas";

const logger = createClientLogger("spec-studio-controls");
const HARD_CONFIRMATION = "APPLY PROSPECTIVELY";
const GATES: readonly SpecGate[] = [
  "requirements",
  "design",
  "plan",
  "execution_start",
  "delivery",
];

const gateLabels: Record<SpecGate, string> = {
  requirements: "Requirements",
  design: "Design",
  plan: "Plan",
  execution_start: "Execution start",
  delivery: "Delivery",
};

const presetLabels: Record<SpecGatePreset, string> = {
  "contract-bearing": "Contract-bearing",
  exploratory: "Exploratory",
  "fast-path": "Fast path",
};

const dispositionLabels: Record<SpecCriterionDisposition, string> = {
  in_scope: "In scope",
  deferred: "Deferred",
  waived: "Waived",
  delivered_elsewhere: "Delivered elsewhere",
};

export const integrityReportSchema = z
  .object({
    ok: z.boolean(),
    checkedRevisionIds: z.array(z.string().min(1)),
    mismatches: z.array(
      z
        .object({
          revisionId: z.string().min(1),
          expectedContentHash: z.string(),
          actualContentHash: z.string(),
          mismatchedElementIds: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

export type IntegrityReportView = z.infer<typeof integrityReportSchema>;

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

export function PolicyDialog({
  currentPolicy,
  pending,
  error,
  onChangePolicy,
}: {
  currentPolicy: SpecGatePolicy;
  pending: boolean;
  error: string | null;
  onChangePolicy(input: {
    proposedPolicy: SpecGatePolicy;
    hardConfirmed: boolean;
  }): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<SpecGatePreset>(currentPolicy.preset);
  const [overrides, setOverrides] = useState<Record<SpecGate, GateSelection>>(
    () => policyOverrides(currentPolicy),
  );
  const [confirmation, setConfirmation] = useState("");
  const proposedPolicy = proposedGatePolicy(preset, overrides);
  const requiresConfirmation = policyChangeRequiresHardConfirmation(
    currentPolicy,
    proposedPolicy,
  );
  const confirmed = confirmation === HARD_CONFIRMATION;

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setPreset(currentPolicy.preset);
    setOverrides(policyOverrides(currentPolicy));
    setConfirmation("");
  }

  function handleApply(): void {
    onChangePolicy({
      proposedPolicy,
      hardConfirmed: requiresConfirmation && confirmed,
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button size="sm">Change policy</Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="default">
        <AlertDialogTitle>Change gate policy</AlertDialogTitle>
        <AlertDialogDescription>
          Policy changes apply only to prospective executions. Existing revision
          approvals and execution pins remain unchanged.
        </AlertDialogDescription>

        <FormGroup layoutClassName="mt-lg">
          <FormLabel>Preset</FormLabel>
          <Select
            value={preset}
            onValueChange={(value) => setPreset(value as SpecGatePreset)}
          >
            <SelectTrigger aria-label="Preset" layoutClassName="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(presetLabels) as SpecGatePreset[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {presetLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormGroup>

        <div className="grid grid-cols-2 gap-sm max-768:grid-cols-1">
          {GATES.map((gate) => (
            <FormGroup key={gate} layoutClassName="mb-sm">
              <FormLabel>{gateLabels[gate]} gate</FormLabel>
              <Select
                value={overrides[gate]}
                onValueChange={(value) =>
                  setOverrides((current) => ({
                    ...current,
                    [gate]: value as GateSelection,
                  }))
                }
              >
                <SelectTrigger
                  aria-label={`${gateLabels[gate]} gate`}
                  layoutClassName="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">Inherit preset</SelectItem>
                  <SelectItem value="gate">Gate</SelectItem>
                  <SelectItem value="notify">Notify</SelectItem>
                  {gate !== "delivery" && (
                    <SelectItem value="off">Off</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </FormGroup>
          ))}
        </div>

        {requiresConfirmation && (
          <FormGroup layoutClassName="mt-md mb-sm">
            <FormLabel htmlFor="spec-policy-hard-confirmation">
              Hard confirmation
            </FormLabel>
            <FormInput
              id="spec-policy-hard-confirmation"
              aria-label="Hard confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
              placeholder={HARD_CONFIRMATION}
              autoComplete="off"
            />
            <FormHint>
              Type {HARD_CONFIRMATION} to confirm this prospective policy
              change.
            </FormHint>
          </FormGroup>
        )}
        {error !== null && <FormError role="alert">{error}</FormError>}
        <AlertDialogActions>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleApply}
            loading={pending}
            disabled={requiresConfirmation && !confirmed}
          >
            Apply policy
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
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
          admission.gate === gate && admission.execution_id === execution.id,
      );
  const deliveryAdmitted = gateAdmitted("delivery");
  const executionStartAdmitted = gateAdmitted("execution_start");

  if (activeExecution !== undefined) {
    const pinnedSnapshot = snapshotForExecution(detail, activeExecution);
    const pinnedSelectedCriteria = selectedCriterionIds(
      activeExecution.scope_json,
    );
    return (
      <section
        aria-labelledby="spec-execution-heading"
        className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
      >
        <div className="flex flex-wrap items-start justify-between gap-md">
          <div>
            <h2
              id="spec-execution-heading"
              className="m-0 font-display text-[0.92rem] font-bold text-text-primary"
            >
              Execution
            </h2>
            <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
              Revision {activeExecution.revision_id} is pinned to this run.
            </p>
          </div>
          <StatusChip
            tone={
              activeExecution.state === "definition_review" ? "amber" : "cyan"
            }
          >
            {executionStateLabel(activeExecution.state)}
          </StatusChip>
        </div>
        <div className="mt-md flex flex-wrap gap-md">
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/workflows?definition=${encodeURIComponent(activeExecution.workflow_definition_id)}`}
            className="font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Open workflow definition
          </Link>
          {activeExecution.workflow_execution_id !== null &&
            activeExecution.session_name !== null && (
              <Link
                href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(activeExecution.session_name)}/workflow`}
                className="font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                Open workflow run
              </Link>
            )}
        </div>

        {activeExecution.state === "definition_review" &&
          executionStartRequiresGateApproval &&
          (executionStartAdmitted(activeExecution) ? (
            <div className="mt-md flex flex-wrap items-center gap-md rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
              <StatusChip tone="green">Execution start approved</StatusChip>
              <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
                A human approved this run&apos;s start. If the workflow
                hasn&apos;t begun, start it from the session — the approval
                stays recorded.
              </p>
            </div>
          ) : (
            <div className="mt-md flex flex-wrap items-center gap-md rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
              <Button
                size="sm"
                variant="success"
                loading={pendingAction === "approve-execution-start"}
                onClick={() =>
                  onApproveExecutionStart({
                    executionId: activeExecution.id,
                  })
                }
              >
                Approve &amp; start
              </Button>
              <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
                The compiled definition won&apos;t run until a human approves
                this execution&apos;s start.
              </p>
            </div>
          ))}

        {deliveryRequiresGateApproval &&
          (deliveryAdmitted(activeExecution) ? (
            <div className="mt-md flex flex-wrap items-center gap-md rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
              <StatusChip tone="green">Delivery approved</StatusChip>
              <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
                A human approved delivery for this run. The merge still needs
                valid proof or a waiver for every in-scope criterion before the
                gate admits it.
              </p>
            </div>
          ) : (
            <div className="mt-md flex flex-wrap items-center gap-md rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
              <Button
                size="sm"
                variant="success"
                loading={pendingAction === "grant-gate-approval"}
                onClick={() =>
                  onGrantGateApproval({
                    executionId: activeExecution.id,
                    revisionId: activeExecution.revision_id,
                  })
                }
              >
                Approve delivery
              </Button>
              <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
                The delivery gate refuses this run&apos;s merge until a human
                approves delivery.
              </p>
            </div>
          ))}

        {/* The service refuses capture for any non-running execution, so the
            control renders only for the state the server accepts. */}
        {activeExecution.state === "running" && (
          <CaptureDiscoveredWorkForm
            executionId={activeExecution.id}
            pending={pendingAction === "capture-scope-amendment"}
            onCapture={onCaptureScopeAmendment}
          />
        )}

        <div className="mt-lg grid gap-md">
          {(pinnedSnapshot?.elements ?? []).flatMap((entry) => {
            if (entry.version.payload.kind !== "criterion") return [];
            const handle = criterionHandle(pinnedSnapshot, entry.element.id);
            if (handle === null) return [];
            const criterionDisposition = detail.criterionDispositions.find(
              (row) =>
                row.execution_id === activeExecution.id &&
                row.criterion_element_id === entry.element.id,
            );
            return [
              <CriterionExecutionControls
                key={`${entry.element.id}:${criterionDisposition?.updated_at ?? "initial"}`}
                criterionElementId={entry.element.id}
                handle={handle}
                text={entry.version.payload.text}
                execution={activeExecution}
                pinnedInScope={pinnedSelectedCriteria.has(entry.element.id)}
                disposition={criterionDisposition}
                waiver={detail.waivers.find(
                  (row) =>
                    row.criterion_element_id === entry.element.id &&
                    row.revision_id === activeExecution.revision_id &&
                    row.stale === 0,
                )}
                deliveredExecution={detail.executions.find(
                  (candidate) => candidate.state === "delivered",
                )}
                pendingAction={pendingAction}
                onGrantWaiver={onGrantWaiver}
                onSetDisposition={onSetDisposition}
              />,
            ];
          })}
        </div>
        {error !== null && (
          <p
            role="alert"
            className="mt-md mb-0 font-mono text-[0.72rem] text-red"
          >
            {error}
          </p>
        )}
      </section>
    );
  }

  if (approvedSnapshot === null) {
    return (
      <section className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg">
        <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
          Execution
        </h2>
        <p className="mt-sm mb-0 text-[0.76rem] leading-relaxed text-text-secondary">
          Approve a revision before selecting an execution scope.
        </p>
      </section>
    );
  }

  return (
    <ExecutionScopeForm
      snapshot={approvedSnapshot}
      projectName={projectName}
      pending={pendingAction === "start-execution"}
      error={error}
      onStart={onStart}
    />
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
    const selectedCriteria = new Set(selectedCriterionIds);
    onStart({
      revisionId: snapshot.revision.id,
      sessionName: sessionName.trim() || null,
      scope: {
        selectedTaskIds,
        selectedCriterionIds,
        exclusionDispositions: criteria.flatMap((entry) =>
          selectedCriteria.has(entry.element.id)
            ? []
            : [
                {
                  criterionId: entry.element.id,
                  disposition: "deferred" as const,
                },
              ],
        ),
      },
    });
  }

  return (
    <section
      aria-labelledby="spec-execution-heading"
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
    >
      <h2
        id="spec-execution-heading"
        className="m-0 font-display text-[0.92rem] font-bold text-text-primary"
      >
        Start execution
      </h2>
      <p className="mt-xs mb-0 text-[0.76rem] leading-relaxed text-text-secondary">
        Select the exact task and criterion scope to compile for {projectName}.
        Excluded criteria are explicitly deferred.
      </p>

      <div className="mt-lg grid grid-cols-2 gap-lg max-768:grid-cols-1">
        <fieldset className="m-0 grid gap-sm border-0 p-0">
          <legend className="mb-sm font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase">
            Tasks
          </legend>
          {tasks.map((entry) => (
            <CheckboxField
              key={entry.element.id}
              checked={selectedTaskIds.includes(entry.element.id)}
              onCheckedChange={(checked) =>
                toggleSelection(
                  entry.element.id,
                  checked === true,
                  setSelectedTaskIds,
                )
              }
              label={`T${entry.element.number ?? "?"} ${
                entry.version.payload.kind === "task"
                  ? entry.version.payload.title
                  : ""
              }`}
            />
          ))}
        </fieldset>
        <fieldset className="m-0 grid gap-sm border-0 p-0">
          <legend className="mb-sm font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase">
            Acceptance criteria
          </legend>
          {criteria.map((entry) => {
            const handle = criterionHandle(snapshot, entry.element.id);
            return (
              <CheckboxField
                key={entry.element.id}
                checked={selectedCriterionIds.includes(entry.element.id)}
                onCheckedChange={(checked) =>
                  toggleSelection(
                    entry.element.id,
                    checked === true,
                    setSelectedCriterionIds,
                  )
                }
                label={`${handle ?? "Criterion"} ${
                  entry.version.payload.kind === "criterion"
                    ? entry.version.payload.text
                    : ""
                }`}
              />
            );
          })}
        </fieldset>
      </div>

      <FormGroup layoutClassName="mt-lg mb-md">
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
      </FormGroup>
      {error !== null && <FormError role="alert">{error}</FormError>}
      <Button
        variant="primary"
        loading={pending}
        disabled={
          selectedTaskIds.length === 0 || selectedCriterionIds.length === 0
        }
        onClick={handleStart}
      >
        Start execution
      </Button>
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

function CriterionExecutionControls({
  criterionElementId,
  handle,
  text,
  execution,
  pinnedInScope,
  disposition,
  waiver,
  deliveredExecution,
  pendingAction,
  onGrantWaiver,
  onSetDisposition,
}: {
  criterionElementId: string;
  handle: string;
  text: string;
  execution: SpecExecutionRow;
  pinnedInScope: boolean;
  disposition: SpecCriterionDispositionRow | undefined;
  waiver: SpecWaiverRow | undefined;
  deliveredExecution: SpecExecutionRow | undefined;
  pendingAction: string | null;
  onGrantWaiver(input: GrantWaiverInput): void;
  onSetDisposition(input: SetDispositionInput): void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [selectedDisposition, setSelectedDisposition] = useState<
    "" | "waived" | "delivered_elsewhere"
  >(terminalDisposition(disposition?.disposition));

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
    <article className="rounded-md border border-solid border-border-dim bg-bg-base p-md">
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div>
          <h3 className="m-0 font-mono text-[0.76rem] font-bold text-text-primary">
            {handle}
          </h3>
          <p className="mt-xs mb-0 text-[0.74rem] leading-relaxed text-text-secondary">
            {text}
          </p>
        </div>
        <StatusChip
          tone={disposition?.disposition === "waived" ? "amber" : "neutral"}
        >
          {dispositionLabels[disposition?.disposition ?? "in_scope"]}
        </StatusChip>
      </div>

      <p className="mt-sm mb-0 font-mono text-[0.66rem] text-text-tertiary">
        {pinnedInScope ? "Pinned in scope" : "Pinned deferred"}; membership
        cannot change during this run.
      </p>

      {!pinnedInScope ? (
        <p className="mt-md mb-0 rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm font-mono text-[0.68rem] leading-relaxed text-text-tertiary">
          Deferred at execution start. This criterion remains outside this
          delivery and cannot receive a waiver or delivered-elsewhere outcome.
        </p>
      ) : (
        <>
          <div className="mt-md grid grid-cols-[minmax(0,1fr)_auto] items-end gap-sm max-768:grid-cols-1">
            <FormGroup layoutClassName="mb-0">
              <FormLabel>Disposition</FormLabel>
              <Select
                value={selectedDisposition}
                onValueChange={(value) =>
                  setSelectedDisposition(
                    value as "waived" | "delivered_elsewhere",
                  )
                }
              >
                <SelectTrigger
                  aria-label={`Disposition for ${handle}`}
                  layoutClassName="w-full"
                >
                  <SelectValue />
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
            </FormGroup>
            <Button
              size="sm"
              loading={pendingAction === "set-disposition"}
              disabled={!canSaveDisposition}
              aria-label={`Save disposition for ${handle}`}
              onClick={saveDisposition}
            >
              Save disposition
            </Button>
          </div>

          {waiver === undefined ? (
            <div className="mt-md border-x-0 border-t border-b-0 border-solid border-border-dim pt-md">
              <FormGroup layoutClassName="mb-sm">
                <FormLabel htmlFor={`waiver-reason-${criterionElementId}`}>
                  Waiver reason
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
                aria-label={`Grant waiver for ${handle}`}
                onClick={() =>
                  onGrantWaiver({
                    criterionElementId,
                    revisionId: execution.revision_id,
                    reason: reason.trim(),
                  })
                }
              >
                Grant waiver
              </Button>
            </div>
          ) : (
            <p className="mt-md mb-0 font-mono text-[0.68rem] text-amber">
              Waiver recorded with a required human reason.
            </p>
          )}
        </>
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
  admissions: SpecGateAdmissionRow[];
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
              {gateLabels[admission.gate]} gate · {admission.created_at}
              {admission.revision_id !== null &&
                ` · revision ${admission.revision_id}`}
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
  report: IntegrityReportView | null;
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
  if (isPending || report === null || report.ok) return null;

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

const startExecutionResponseSchema = z
  .object({
    execution: specExecutionRowSchema,
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
  const [integrityReport, setIntegrityReport] =
    useState<IntegrityReportView | null>(null);
  const verifiedSpecId = useRef<string | null>(null);
  const changePolicy = useSpecActionMutation<
    { proposedPolicy: SpecGatePolicy; hardConfirmed: boolean },
    z.infer<typeof specSchema>
  >(projectName, detail.spec.slug, "change-policy", specSchema);
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
  const verify = useSpecActionMutation<
    Record<string, never>,
    IntegrityReportView
  >(projectName, detail.spec.slug, "verify", integrityReportSchema);

  useEffect(() => {
    if (verifiedSpecId.current === detail.spec.id) return;
    verifiedSpecId.current = detail.spec.id;
    verify.mutate(
      {},
      {
        onSuccess: (report) => {
          setIntegrityReport(report);
          if (!report.ok) {
            logger.error("spec_studio.integrity.mismatch", {
              specId: detail.spec.id,
              mismatchCount: report.mismatches.length,
            });
          }
        },
        onError: (mutationError) => {
          logger.warn("spec_studio.integrity.verify_failed", {
            specId: detail.spec.id,
            error: mutationError.message,
          });
        },
      },
    );
  }, [detail.spec.id, verify]);

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
                : null;

  return (
    <div>
      <IntegrityBanner
        report={integrityReport}
        isPending={verify.isPending}
        error={verify.error?.message ?? null}
      />
      <PolicyAdmissionNotices admissions={detail.gateAdmissions} />
      <div className="mb-lg flex flex-wrap items-center justify-between gap-md rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg">
        <div>
          <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
            Gate policy
          </h2>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
            {presetLabels[detail.spec.gatePolicy.preset]} preset
          </p>
        </div>
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
        />
      </div>
      <ExecutionPanel
        detail={detail}
        projectName={projectName}
        pendingAction={pendingAction}
        error={
          actionFailure !== null && actionFailure.action !== "change-policy"
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

function approvedRevisionSnapshot(
  detail: SpecDetailView,
): SpecRevisionSnapshot | null {
  return detail.currentApprovedRevision?.revision.state === "approved"
    ? detail.currentApprovedRevision
    : null;
}

function snapshotForExecution(
  detail: SpecDetailView,
  execution: SpecExecutionRow,
): SpecRevisionSnapshot | null {
  return (
    [
      detail.currentRevision,
      detail.baseRevision,
      detail.currentApprovedRevision,
      ...detail.executionRevisionSnapshots,
    ].find((snapshot) => snapshot?.revision.id === execution.revision_id) ??
    null
  );
}

function selectedCriterionIds(scopeJson: string): ReadonlySet<string> {
  try {
    const parsed = executionScopeSchema.safeParse(JSON.parse(scopeJson));
    return new Set(parsed.success ? parsed.data.selectedCriterionIds : []);
  } catch {
    return new Set();
  }
}

function terminalDisposition(
  disposition: SpecCriterionDisposition | undefined,
): "" | "waived" | "delivered_elsewhere" {
  return disposition === "waived" || disposition === "delivered_elsewhere"
    ? disposition
    : "";
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

function executionStateLabel(state: SpecExecutionRow["state"]): string {
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
