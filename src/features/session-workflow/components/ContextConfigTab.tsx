"use client";

import { useId, useMemo, useState } from "react";
import {
  MultilineInput,
  MultilinePrimaryActionScope,
  useMultilinePrimaryActionRegistry,
} from "@/components/MultilineInput";
import {
  CircuitBreakerEditor,
  CollaborationEditor,
  ContextValidatorEditor,
  ImplementerEditor,
  IterationPolicyEditor,
  PlanRepairEditor,
  ToggleControl,
} from "@/components/workflow-config/FieldEditors";
import {
  OutputSchemaField,
  lintOutputSchemaText,
} from "@/components/workflow-config/OutputSchemaField";
import { cn } from "@/lib/ui/cn";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
} from "@/lib/workflow-graph/lifecycle-classifier";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  ResolvedCollaborationConfig,
  WorkflowCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
  GraphWorkflowPlanRepairPolicy,
} from "@/lib/workflow-graph/config-schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";

const BLOCK = "rounded-md border border-solid border-border-subtle bg-bg-base";
const BLOCK_HEADER = "flex items-center gap-[10px] px-[14px] py-[10px]";
const BLOCK_LABEL =
  "font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase";
const BLOCK_BODY = "border-t border-solid border-border-dim p-[14px]";
const BLOCK_TEXT = "text-[0.74rem] leading-[1.5] text-text-secondary";

const PROSE_LABEL =
  "mb-1 block font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase";
const PROSE_INPUT =
  "w-full rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[7px] text-[0.75rem] text-text-primary transition-[border-color] duration-150 outline-none focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-60";
const PROSE_TEXTAREA = "resize-y min-h-[56px] leading-[1.5]";

const btn =
  "inline-flex items-center justify-center gap-[6px] rounded-sm border border-solid px-[12px] py-[6px] text-[0.72rem] font-medium whitespace-nowrap transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50";
const btnPrimary =
  "border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a12)] text-cyan enabled:cursor-pointer enabled:hover:bg-[var(--cc-cyan-a20)]";
const btnDefault =
  "border-border-default bg-bg-raised text-text-secondary enabled:cursor-pointer enabled:hover:border-border-strong enabled:hover:text-text-primary";

// The resolved collaboration config carries per-field provenance ({value,
// source}); the shared CollaborationEditor edits the flat shape. These two
// projections bridge display/edit and edit → live-edit op.
function toFlatCollaboration(
  resolved: ResolvedCollaborationConfig,
): WorkflowCollaborationConfig {
  return {
    enabled: resolved.enabled.value,
    secondAgent: resolved.secondAgent.value,
    negotiationRounds: resolved.negotiationRounds.value,
    autonomousResolutionThreshold: resolved.autonomousResolutionThreshold.value,
  };
}

// Live config edits set concrete resolved values (doc 06, D1); a human edit is
// attributed to the per-node layer.
function toProvenancedCollaboration(
  flat: WorkflowCollaborationConfig,
): ResolvedCollaborationConfig {
  return {
    enabled: { value: flat.enabled, source: "per-node" },
    secondAgent: { value: flat.secondAgent, source: "per-node" },
    negotiationRounds: { value: flat.negotiationRounds, source: "per-node" },
    autonomousResolutionThreshold: {
      value: flat.autonomousResolutionThreshold,
      source: "per-node",
    },
  };
}

// Seed for enabling a previously-off context validator: a concrete Claude
// validator the operator can then refine.
const DEFAULT_CONTEXT_VALIDATOR: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
};

// The editable projection of a resolved context: prose plus every concrete
// config block the live-edit endpoint accepts. Collaboration is held flat
// (null when the resolved context has none — editing it is out of scope until
// there is a resolved value to edit).
interface ConfigDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** RAW editor text, never a parsed document: a half-typed schema has to
   * survive a re-render and an SSE rebase, and only a text draft can hold one.
   * Parsed to object-or-null at diff time (D8/R7.5). */
  outputSchema: string;
  implementer: GraphWorkflowAgentConfig;
  contextValidator: GraphWorkflowAgentValidatorConfig | null;
  scriptValidator: boolean;
  humanApprovalGate: boolean;
  askUserQuestions: boolean;
  mutability: boolean;
  iterationPolicy: GraphWorkflowIterationPolicy;
  circuitBreaker: GraphWorkflowCircuitBreakerPolicy;
  planRepair: GraphWorkflowPlanRepairPolicy;
  collaboration: WorkflowCollaborationConfig | null;
}

type ResolvedContext =
  GraphWorkflowExecution["workingDefinition"]["executionContexts"][number];

/**
 * An in-flight `outputSchema` submission, held until the server is observed to
 * agree with it. `text` is the raw editor text that produced the op; `canonical`
 * is how the stored document will serialize back through `toDraft`;
 * `atRevision` is the `liveRevision` it was authored against.
 *
 * The revision matters because "the server holds my document" is TRUE from the
 * outset for a formatting-only edit — the document never changed, only its
 * text. Without a marker that the stored state actually moved, such a
 * submission would settle the instant it was dispatched.
 */
interface SubmittedSchema {
  text: string;
  canonical: string;
  atRevision: number;
}

/**
 * The one serialization of a stored schema document into editor text.
 *
 * Both the seed (`toDraft`) and the post-submit baseline go through here: the
 * server keeps a PARSED document, so any text whose formatting differs from
 * this function's output would re-seed as a permanent diff against itself.
 */
function serializeOutputSchemaText(
  schema: Record<string, unknown> | null | undefined,
): string {
  return schema ? JSON.stringify(schema, null, 2) : "";
}

function toDraft(context: ResolvedContext): ConfigDraft {
  return {
    title: context.title,
    description: context.description ?? "",
    acceptanceCriteria: context.acceptanceCriteria,
    outputSchema: serializeOutputSchemaText(context.outputSchema),
    implementer: context.implementer,
    contextValidator: context.contextValidator,
    scriptValidator: context.scriptValidator.enabled,
    humanApprovalGate: context.humanApprovalGate.enabled,
    askUserQuestions: context.askUserQuestions.enabled,
    mutability: context.mutability.allowAgentTaskAdd,
    iterationPolicy: context.iterationPolicy,
    circuitBreaker: context.circuitBreaker,
    planRepair: context.planRepair,
    collaboration: context.collaboration
      ? toFlatCollaboration(context.collaboration)
      : null,
  };
}

type UpdateContextOp = Extract<
  WorkflowLiveEditOperation,
  { type: "update-context" }
>;

// Diff draft against the resolved baseline and compose an `update-context` op
// carrying ONLY changed fields, or null when nothing changed (the op requires
// at least one field).
function diffToUpdateContextOp(
  contextId: string,
  draft: ConfigDraft,
  base: ConfigDraft,
): UpdateContextOp | null {
  const changes: Omit<UpdateContextOp, "type" | "contextId"> = {};
  if (draft.title !== base.title) changes.title = draft.title;
  if (draft.description !== base.description) {
    changes.description =
      draft.description.trim().length === 0 ? null : draft.description;
  }
  if (draft.acceptanceCriteria !== base.acceptanceCriteria) {
    changes.acceptanceCriteria = draft.acceptanceCriteria;
  }
  // The only text→document conversion in the tier. Dirtiness is a plain string
  // compare (so reformatting alone still enables Save and re-persists an
  // equivalent document), but unparseable or unsupported text yields no field
  // at all — the save bar's validity gate is what stops such a draft from
  // silently saving everything EXCEPT the schema the author is looking at.
  if (draft.outputSchema !== base.outputSchema) {
    const lint = lintOutputSchemaText(draft.outputSchema);
    if (lint.schema !== null) {
      changes.outputSchema = lint.schema;
    } else if (lint.stage === "empty") {
      changes.outputSchema = null;
    }
  }
  if (!deepEqualJson(draft.implementer, base.implementer)) {
    changes.implementer = draft.implementer;
  }
  if (!deepEqualJson(draft.contextValidator, base.contextValidator)) {
    changes.contextValidator = draft.contextValidator;
  }
  if (draft.scriptValidator !== base.scriptValidator) {
    changes.scriptValidator = { enabled: draft.scriptValidator };
  }
  if (draft.humanApprovalGate !== base.humanApprovalGate) {
    changes.humanApprovalGate = { enabled: draft.humanApprovalGate };
  }
  if (draft.askUserQuestions !== base.askUserQuestions) {
    changes.askUserQuestions = { enabled: draft.askUserQuestions };
  }
  if (draft.mutability !== base.mutability) {
    changes.mutability = { allowAgentTaskAdd: draft.mutability };
  }
  if (!deepEqualJson(draft.iterationPolicy, base.iterationPolicy)) {
    changes.iterationPolicy = draft.iterationPolicy;
  }
  if (!deepEqualJson(draft.circuitBreaker, base.circuitBreaker)) {
    changes.circuitBreaker = draft.circuitBreaker;
  }
  if (!deepEqualJson(draft.planRepair, base.planRepair)) {
    changes.planRepair = draft.planRepair;
  }
  if (
    draft.collaboration &&
    base.collaboration &&
    !deepEqualJson(draft.collaboration, base.collaboration)
  ) {
    changes.collaboration = toProvenancedCollaboration(draft.collaboration);
  }

  if (Object.keys(changes).length === 0) return null;
  return { type: "update-context", contextId, ...changes };
}

// Three-way merge of one field: if the user changed it from the baseline
// (`ours` diverges from `base`), keep their value; otherwise adopt the incoming
// `theirs`.
function threeWay<T>(ours: T, base: T, theirs: T): T {
  return deepEqualJson(ours, base) ? theirs : ours;
}

// Rebase a stale draft onto a freshly-refetched baseline, preserving ONLY the
// fields the user actually edited. Fields the user never touched adopt the
// fresh value, so a concurrent edit to an untouched field is neither displayed
// stale nor echoed back into the retry payload (no lost update).
function rebaseDraft(
  draft: ConfigDraft,
  seedBase: ConfigDraft,
  freshBase: ConfigDraft,
): ConfigDraft {
  return {
    title: threeWay(draft.title, seedBase.title, freshBase.title),
    description: threeWay(
      draft.description,
      seedBase.description,
      freshBase.description,
    ),
    acceptanceCriteria: threeWay(
      draft.acceptanceCriteria,
      seedBase.acceptanceCriteria,
      freshBase.acceptanceCriteria,
    ),
    outputSchema: threeWay(
      draft.outputSchema,
      seedBase.outputSchema,
      freshBase.outputSchema,
    ),
    implementer: threeWay(
      draft.implementer,
      seedBase.implementer,
      freshBase.implementer,
    ),
    contextValidator: threeWay(
      draft.contextValidator,
      seedBase.contextValidator,
      freshBase.contextValidator,
    ),
    scriptValidator: threeWay(
      draft.scriptValidator,
      seedBase.scriptValidator,
      freshBase.scriptValidator,
    ),
    humanApprovalGate: threeWay(
      draft.humanApprovalGate,
      seedBase.humanApprovalGate,
      freshBase.humanApprovalGate,
    ),
    askUserQuestions: threeWay(
      draft.askUserQuestions,
      seedBase.askUserQuestions,
      freshBase.askUserQuestions,
    ),
    mutability: threeWay(
      draft.mutability,
      seedBase.mutability,
      freshBase.mutability,
    ),
    iterationPolicy: threeWay(
      draft.iterationPolicy,
      seedBase.iterationPolicy,
      freshBase.iterationPolicy,
    ),
    circuitBreaker: threeWay(
      draft.circuitBreaker,
      seedBase.circuitBreaker,
      freshBase.circuitBreaker,
    ),
    planRepair: threeWay(
      draft.planRepair,
      seedBase.planRepair,
      freshBase.planRepair,
    ),
    collaboration: threeWay(
      draft.collaboration,
      seedBase.collaboration,
      freshBase.collaboration,
    ),
  };
}

// The three read-only states + the one editable state the config surface can be
// in, resolved from the shared lifecycle classifier (doc 06, "UI plan" Goal 2).
type ConfigAffordance =
  | { mode: "editable" }
  | { mode: "frozen" }
  | { mode: "pause-to-edit" }
  | {
      mode: "read-only";
      reason: "completed" | "aborted" | "halt-not-resumable";
    };

function resolveAffordance(
  execution: GraphWorkflowExecution,
  contextId: string,
): ConfigAffordance {
  const executionEditability = classifyExecutionEditability(execution);
  if (executionEditability.kind === "not-editable") {
    return { mode: "read-only", reason: executionEditability.reason };
  }
  const lifecycle = classifyContextLifecycle(execution, contextId);
  if (lifecycle === "frozen") return { mode: "frozen" };
  if (lifecycle === "unstarted") return { mode: "editable" };
  // `started` — editable only when the execution is quiescent.
  return executionEditability.quiescent
    ? { mode: "editable" }
    : { mode: "pause-to-edit" };
}

const READ_ONLY_REASON_TEXT: Record<
  "completed" | "aborted" | "halt-not-resumable",
  string
> = {
  completed: "This execution has completed and can no longer be edited.",
  aborted: "This execution was aborted and can no longer be edited.",
  "halt-not-resumable":
    "This execution halted with a non-resumable reason and can no longer be edited.",
};

// Why the schema editor is disabled, in the terms of the mode that disabled it.
// A generic "read-only" would leave the author guessing whether the contract is
// recoverable; `pause-to-edit` in particular is the one mode with a way out.
const OUTPUT_SCHEMA_READ_ONLY_HINT: Record<
  Exclude<ConfigAffordance["mode"], "editable">,
  string
> = {
  frozen:
    "The output was already captured against this schema — editing it now would not re-validate anything.",
  "read-only":
    "This execution is no longer running; its working definition is immutable.",
  "pause-to-edit":
    "Pause the execution to change the contract before the next iteration runs.",
};

function LockIcon(): React.JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      className="shrink-0"
      data-testid="config-frozen-lock"
    >
      <rect x="3.2" y="7" width="9.6" height="6.8" rx="1.2" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" strokeLinecap="round" />
    </svg>
  );
}

function ConfigBlock({
  testId,
  label,
  headerRight,
  children,
}: {
  testId: string;
  label: string;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn(BLOCK, "overflow-hidden")} data-testid={testId}>
      <div className={BLOCK_HEADER}>
        <span className={cn(BLOCK_LABEL, "min-w-0 flex-1")}>{label}</span>
        {headerRight ? (
          <span className="flex shrink-0 items-center">{headerRight}</span>
        ) : null}
      </div>
      {children ? <div className={BLOCK_BODY}>{children}</div> : null}
    </div>
  );
}

function GateBlock({
  testId,
  label,
  description,
  enabled,
  disabled,
  ariaLabel,
  onChange,
}: {
  testId: string;
  label: string;
  description: string;
  enabled: boolean;
  disabled: boolean;
  ariaLabel: string;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <ConfigBlock
      testId={testId}
      label={label}
      headerRight={
        <ToggleControl
          value={enabled}
          onChange={onChange}
          disabled={disabled}
          ariaLabel={ariaLabel}
        />
      }
    >
      <p className={BLOCK_TEXT}>{description}</p>
    </ConfigBlock>
  );
}

const RUNTIME_ROW = "grid grid-cols-[110px_1fr] items-baseline gap-x-[10px]";
const RUNTIME_LABEL =
  "font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase";
const RUNTIME_VALUE =
  "min-w-0 font-mono text-[0.72rem] [overflow-wrap:anywhere] text-text-primary";

function RuntimeRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | null;
  testId: string;
}): React.JSX.Element {
  return (
    <div className={RUNTIME_ROW}>
      <span className={RUNTIME_LABEL}>{label}</span>
      <span className={RUNTIME_VALUE} data-testid={testId}>
        {value && value.length > 0 ? value : "—"}
      </span>
    </div>
  );
}

interface ContextConfigTabProps {
  execution: GraphWorkflowExecution;
  contextId: string;
  /** Compose an `update-context` op batch through the runtime-edits endpoint. */
  onSaveContextConfig?: (operations: WorkflowLiveEditOperation[]) => void;
  /** Pause the running execution so a `started` context becomes editable. */
  onPauseExecution?: () => void;
  /** Resume the execution once edits are saved (offered after a save). */
  onResumeExecution?: () => void;
  isSaving?: boolean;
  isPausing?: boolean;
  isResuming?: boolean;
  /** The last save hit a `revision_conflict` — surface the retry notice. */
  editConflict?: boolean;
  /** The last save succeeded — offer Resume for the pause-to-edit flow. */
  saveSucceeded?: boolean;
}

/**
 * The selected context's fully-resolved configuration (doc 06, "UI plan").
 * Everything renders straight from the execution's already-resolved
 * `workingDefinition` — no cascade logic client-side. Editability is driven by
 * the SAME lifecycle classifier the server's edit guard uses, so the human can
 * edit exactly what the endpoint accepts, and only when the endpoint would
 * accept it. Saves compose a single `update-context` op batch and follow the
 * responsiveness contract (visible pending state, never invalidation alone).
 */
export default function ContextConfigTab({
  execution,
  contextId,
  onSaveContextConfig,
  onPauseExecution,
  onResumeExecution,
  isSaving = false,
  isPausing = false,
  isResuming = false,
  editConflict = false,
  saveSucceeded = false,
}: ContextConfigTabProps): React.JSX.Element | null {
  const descriptionId = useId();
  const acceptanceCriteriaId = useId();
  const multilineActions = useMultilinePrimaryActionRegistry();
  const context = execution.workingDefinition.executionContexts.find(
    (candidate) => candidate.id === contextId,
  );
  const contextState = execution.contextStates[contextId];

  const freshBase = useMemo(
    () => (context ? toDraft(context) : null),
    [context],
  );

  const [draft, setDraft] = useState<ConfigDraft | null>(freshBase);
  // The baseline the draft's edits are measured against. Diffs (and the dirty
  // flag) compare the draft to THIS, never to the live `freshBase`, so a
  // concurrent edit that moves an untouched field can never enter the retry
  // payload — the core lost-update guard.
  const [seedBase, setSeedBase] = useState<ConfigDraft | null>(freshBase);
  const [seededFor, setSeededFor] = useState(contextId);
  const [submittedSchema, setSubmittedSchema] =
    useState<SubmittedSchema | null>(null);

  if (seededFor !== contextId) {
    // Selection changed — reseed wholesale (the panel keys this component by
    // contextId, but the guard keeps it correct standalone).
    setSeededFor(contextId);
    setDraft(freshBase);
    setSeedBase(freshBase);
    setSubmittedSchema(null);
  } else if (draft && seedBase && freshBase) {
    // A schema submission is acknowledged only once the stored state has moved
    // AND the server's own copy serializes to what we sent — never at dispatch,
    // when the outcome is still unknown. Normalizing early would make a
    // formatting-only edit string-equal to `seedBase`, and a rejected save
    // would then rebase as "untouched": the concurrent schema wins and the
    // submitted document is lost silently.
    //
    // Each conjunct rules out a distinct false settle: `saveSucceeded` is our
    // own mutation reporting success, so a submission can never settle while
    // its outcome is unknown — a revision that moved only proves SOME write
    // landed, and an unrelated concurrent edit supplies that on its own;
    // `editConflict` is the rejection itself; the revision proves the write is
    // observable in what we are reading (a formatting-only edit matches the
    // stored document from the outset, so the document check alone would fire
    // immediately); the document check proves the write that landed agrees
    // with ours; and the text check lets a later keystroke revoke it, so text
    // the user has moved on from never settles.
    const acknowledged =
      submittedSchema !== null &&
      saveSucceeded &&
      !editConflict &&
      execution.liveRevision !== submittedSchema.atRevision &&
      freshBase.outputSchema === submittedSchema.canonical &&
      draft.outputSchema === submittedSchema.text;
    // Adopting the canonical serialization is what settles the draft clean:
    // `toDraft` re-serializes the stored document, so raw text that differs
    // only in formatting would otherwise stay dirty against itself forever.
    const reconciled = acknowledged
      ? { ...draft, outputSchema: submittedSchema.canonical }
      : draft;
    if (acknowledged) setSubmittedSchema(null);

    if (!deepEqualJson(freshBase, seedBase)) {
      // The execution moved underneath us (a revision-conflict refetch, or a
      // concurrent add_task/UI edit arriving over SSE). Three-way rebase onto
      // the fresh baseline: keep the fields the user actually edited, adopt the
      // fresh value everywhere else, and advance the baseline so only the
      // user's own edits stay dirty.
      setDraft(rebaseDraft(reconciled, seedBase, freshBase));
      setSeedBase(freshBase);
    } else if (reconciled !== draft) {
      // The document was already what we sent, so no rebase runs — but the raw
      // text still has to adopt the stored form to settle clean.
      setDraft(reconciled);
    }
  }

  const affordance = resolveAffordance(execution, contextId);
  const editable = affordance.mode === "editable";
  const readOnly = !editable;

  const pendingOp = useMemo(
    () =>
      draft && seedBase
        ? diffToUpdateContextOp(contextId, draft, seedBase)
        : null,
    [contextId, draft, seedBase],
  );
  // Dirtiness cannot be `pendingOp !== null` alone any more: text that does not
  // parse produces no op, yet the author has unmistakably changed something.
  // Splitting the two lets the save bar say "you have changes AND they are not
  // saveable" instead of silently pretending the edit never happened.
  const schemaTextDirty =
    draft !== null &&
    seedBase !== null &&
    draft.outputSchema !== seedBase.outputSchema;
  const schemaInvalid =
    draft !== null &&
    lintOutputSchemaText(draft.outputSchema).issues.length > 0;
  const dirty = pendingOp !== null || schemaTextDirty;

  if (!context || !draft) return null;

  const iterationCount = contextState?.iterationCount ?? 0;
  const maxIterations = draft.iterationPolicy.maxIterations;

  function patch(next: Partial<ConfigDraft>) {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  }

  function handleSave(completed?: Partial<ConfigDraft>) {
    if (
      !onSaveContextConfig ||
      !draft ||
      !seedBase ||
      isSaving ||
      readOnly ||
      schemaInvalid
    ) {
      return;
    }
    const submittedDraft = completed ? { ...draft, ...completed } : draft;
    const submittedOp = diffToUpdateContextOp(
      contextId,
      submittedDraft,
      seedBase,
    );
    if (!submittedOp) return;
    onSaveContextConfig([submittedOp]);
    // Record what was sent and the form the server will echo back, but leave
    // the draft alone: the outcome is not known yet, and the reconciliation
    // above adopts the canonical text only once the stored document matches.
    // Holding the submitted TEXT too is what lets a later keystroke revoke the
    // acknowledgement — text the user has moved on from must never settle.
    if (submittedOp.outputSchema !== undefined) {
      setSubmittedSchema({
        text: submittedDraft.outputSchema,
        canonical: serializeOutputSchemaText(submittedOp.outputSchema),
        atRevision: execution.liveRevision,
      });
    }
  }

  const showResume =
    affordance.mode === "editable" &&
    classifyContextLifecycle(execution, contextId) === "started" &&
    saveSucceeded &&
    !dirty &&
    onResumeExecution != null;

  return (
    <MultilinePrimaryActionScope registry={multilineActions}>
      <div
        className="flex flex-col gap-md"
        data-testid="context-config-tab"
        data-scope="config"
        data-affordance={affordance.mode}
      >
        {affordance.mode === "frozen" && (
          <div
            className="flex items-center gap-[8px] rounded-md border border-solid border-border-subtle bg-bg-raised px-[12px] py-[8px] text-[0.72rem] text-text-secondary"
            data-testid="config-affordance-frozen"
          >
            <LockIcon />
            <span>
              This context has completed — its configuration is frozen.
            </span>
          </div>
        )}

        {affordance.mode === "read-only" && (
          <div
            className="rounded-md border border-solid border-border-subtle bg-bg-raised px-[12px] py-[8px] text-[0.72rem] text-text-secondary"
            data-testid="config-affordance-readonly"
          >
            {READ_ONLY_REASON_TEXT[affordance.reason]}
          </div>
        )}

        {affordance.mode === "pause-to-edit" && (
          <div
            className="flex flex-wrap items-center gap-[10px] rounded-md border border-solid border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] px-[12px] py-[8px] text-[0.72rem] text-amber"
            data-testid="config-affordance-pause-to-edit"
          >
            <span className="min-w-0 flex-1">
              This context is in progress. Pause the workflow to edit it.
            </span>
            <button
              type="button"
              className={cn(btn, btnDefault)}
              onClick={() => onPauseExecution?.()}
              disabled={isPausing || onPauseExecution == null}
            >
              {isPausing ? "Pausing…" : "Pause to edit"}
            </button>
          </div>
        )}

        {editConflict && (
          <div
            className="rounded-md border border-solid border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)] px-[12px] py-[8px] text-[0.72rem] text-red"
            data-testid="config-affordance-conflict"
          >
            The execution changed since you started editing. Review your changes
            and retry.
          </div>
        )}

        <section className="flex flex-col gap-sm" data-section="prose">
          <ConfigBlock testId="config-block-prose" label="Context">
            <div className="flex flex-col gap-sm">
              <label>
                <span className={PROSE_LABEL}>Title</span>
                <input
                  className={PROSE_INPUT}
                  value={draft.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  disabled={readOnly}
                  aria-label="Context title"
                />
              </label>
              <div>
                <label className={PROSE_LABEL} htmlFor={descriptionId}>
                  Description
                </label>
                <MultilineInput
                  id={descriptionId}
                  className={cn(PROSE_INPUT, PROSE_TEXTAREA)}
                  rows={3}
                  value={draft.description}
                  onValueChange={(description) => patch({ description })}
                  disabled={readOnly}
                  aria-label="Context description"
                  onPrimaryAction={(description) => {
                    patch({ description });
                    handleSave({ description });
                  }}
                />
              </div>
              <div>
                <label className={PROSE_LABEL} htmlFor={acceptanceCriteriaId}>
                  Acceptance criteria
                </label>
                <MultilineInput
                  id={acceptanceCriteriaId}
                  className={cn(PROSE_INPUT, PROSE_TEXTAREA)}
                  rows={3}
                  value={draft.acceptanceCriteria}
                  onValueChange={(acceptanceCriteria) =>
                    patch({ acceptanceCriteria })
                  }
                  disabled={readOnly}
                  aria-label="Context acceptance criteria"
                  onPrimaryAction={(acceptanceCriteria) => {
                    patch({ acceptanceCriteria });
                    handleSave({ acceptanceCriteria });
                  }}
                />
              </div>
              <OutputSchemaField
                value={draft.outputSchema}
                onChange={(outputSchema) => patch({ outputSchema })}
                readOnly={readOnly}
                readOnlyHint={
                  affordance.mode === "editable"
                    ? undefined
                    : OUTPUT_SCHEMA_READ_ONLY_HINT[affordance.mode]
                }
                footer={
                  schemaTextDirty && !schemaInvalid && editable ? (
                    <div
                      className="mt-[6px] flex items-center gap-[6px] text-[0.7rem] text-cyan"
                      data-testid="config-output-schema-dirty"
                    >
                      <span
                        aria-hidden="true"
                        className="h-[5px] w-[5px] shrink-0 rounded-full bg-cyan shadow-[0_0_4px_var(--cyan-glow)]"
                      />
                      <span>
                        Unsaved — enters the next{" "}
                        <code className="rounded-[3px] bg-bg-raised px-[4px] py-[1px] font-mono">
                          update-context
                        </code>{" "}
                        op.
                      </span>
                    </div>
                  ) : null
                }
              />
            </div>
          </ConfigBlock>
        </section>

        <section className="flex flex-col gap-sm" data-section="agents">
          <ConfigBlock testId="config-block-implementer" label="Implementer">
            <ImplementerEditor
              value={draft.implementer}
              onChange={(next) => patch({ implementer: next })}
              readOnly={readOnly}
            />
          </ConfigBlock>

          <ConfigBlock
            testId="config-block-context-validator"
            label="Context validator"
            headerRight={
              <ToggleControl
                value={draft.contextValidator?.enabled ?? false}
                onChange={(next) => {
                  const current = draft.contextValidator;
                  if (current) {
                    // Preserve the resolved config (type/model/continuity/…) and
                    // flip only `enabled` — a non-null validator with
                    // `enabled:false` is a distinct, valid resolved state.
                    patch({ contextValidator: { ...current, enabled: next } });
                  } else if (next) {
                    // No validator resolved — seed a concrete one to enable it.
                    patch({ contextValidator: DEFAULT_CONTEXT_VALIDATOR });
                  }
                }}
                disabled={readOnly}
                ariaLabel="Context validator enabled"
              />
            }
          >
            {draft.contextValidator === null ? (
              <p className={BLOCK_TEXT}>Off — no validator for this context.</p>
            ) : (
              <ContextValidatorEditor
                value={draft.contextValidator}
                onChange={(next) => patch({ contextValidator: next })}
                readOnly={readOnly}
              />
            )}
          </ConfigBlock>

          {draft.collaboration ? (
            <ConfigBlock
              testId="config-block-collaboration"
              label="Collaboration"
              headerRight={
                <ToggleControl
                  value={draft.collaboration.enabled}
                  onChange={(enabled) => {
                    const collaboration = draft.collaboration;
                    if (!collaboration) return;
                    patch({ collaboration: { ...collaboration, enabled } });
                  }}
                  disabled={readOnly}
                  ariaLabel="Collaboration enabled"
                />
              }
            >
              <CollaborationEditor
                value={draft.collaboration}
                onChange={(next) => patch({ collaboration: next })}
                readOnly={readOnly}
              />
            </ConfigBlock>
          ) : null}
        </section>

        <section className="flex flex-col gap-sm" data-section="quality-gates">
          <GateBlock
            testId="config-block-script-validator"
            label="Script validator"
            description="Runs the project's preMergeCommand before agent validation."
            enabled={draft.scriptValidator}
            disabled={readOnly}
            ariaLabel="Script validator enabled"
            onChange={(next) => patch({ scriptValidator: next })}
          />
          <GateBlock
            testId="config-block-human-approval-gate"
            label="Human approval gate"
            description="Parks for your review before merge after validators pass."
            enabled={draft.humanApprovalGate}
            disabled={readOnly}
            ariaLabel="Human approval gate enabled"
            onChange={(next) => patch({ humanApprovalGate: next })}
          />
          <GateBlock
            testId="config-block-ask-user-questions"
            label="Ask user questions"
            description="Lets the agents ask you questions at decision points."
            enabled={draft.askUserQuestions}
            disabled={readOnly}
            ariaLabel="Ask user questions enabled"
            onChange={(next) => patch({ askUserQuestions: next })}
          />
          <GateBlock
            testId="config-block-mutability"
            label="Agent task add"
            description="Lets agents add tasks to this context during execution."
            enabled={draft.mutability}
            disabled={readOnly}
            ariaLabel="Allow agent task add"
            onChange={(next) => patch({ mutability: next })}
          />
        </section>

        <section
          className="flex flex-col gap-sm"
          data-section="execution-policy"
        >
          <ConfigBlock
            testId="config-block-iteration-policy"
            label="Iteration policy"
            headerRight={
              <span
                className="font-mono text-[0.72rem] text-text-secondary"
                data-testid="config-iteration-count"
              >
                {iterationCount} / {maxIterations}
              </span>
            }
          >
            <IterationPolicyEditor
              value={draft.iterationPolicy}
              onChange={(next) => patch({ iterationPolicy: next })}
              readOnly={readOnly}
            />
          </ConfigBlock>

          <ConfigBlock
            testId="config-block-circuit-breaker"
            label="Circuit breaker"
          >
            <CircuitBreakerEditor
              value={draft.circuitBreaker}
              onChange={(next) => patch({ circuitBreaker: next })}
              readOnly={readOnly}
            />
          </ConfigBlock>

          <ConfigBlock testId="config-block-plan-repair" label="Plan repair">
            <PlanRepairEditor
              value={draft.planRepair}
              onChange={(next) => patch({ planRepair: next })}
              readOnly={readOnly}
            />
          </ConfigBlock>
        </section>

        {contextState ? (
          <section data-section="runtime">
            <div className="mb-sm border-b border-solid border-border-dim pb-xs font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
              Runtime
            </div>
            <div
              className="flex flex-col gap-[6px]"
              data-testid="context-runtime"
            >
              <RuntimeRow
                label="Isolation"
                value={contextState.isolation}
                testId="runtime-isolation"
              />
              <RuntimeRow
                label="Worktree"
                value={contextState.worktreePath}
                testId="runtime-worktree-path"
              />
              <RuntimeRow
                label="Branch"
                value={contextState.branchName}
                testId="runtime-branch"
              />
              <RuntimeRow
                label="Merge"
                value={contextState.mergeStatus}
                testId="runtime-merge-status"
              />
              <RuntimeRow
                label="Cleanup"
                value={contextState.cleanupStatus}
                testId="runtime-cleanup-status"
              />
              <RuntimeRow
                label="Lane"
                value={contextState.laneId}
                testId="runtime-lane"
              />
              <RuntimeRow
                label="Join"
                value={contextState.joinId}
                testId="runtime-join"
              />
              <RuntimeRow
                label="Batch"
                value={contextState.batchId}
                testId="runtime-batch"
              />
              {contextState.lastMergeError ? (
                <RuntimeRow
                  label="Merge error"
                  value={contextState.lastMergeError}
                  testId="runtime-last-merge-error"
                />
              ) : null}
            </div>
          </section>
        ) : null}

        {editable && onSaveContextConfig && (
          <div
            className="sticky bottom-0 flex items-center gap-[8px] border-t border-solid border-border-dim bg-bg-surface py-sm"
            data-testid="config-save-bar"
          >
            <button
              type="button"
              className={cn(btn, btnPrimary)}
              onClick={() => multilineActions.primaryAction(handleSave)}
              disabled={
                isSaving ||
                schemaInvalid ||
                (!dirty && !multilineActions.voiceBusy)
              }
            >
              {isSaving ? "Saving…" : "Save changes"}
            </button>
            {showResume && (
              <button
                type="button"
                className={cn(btn, btnDefault)}
                onClick={() => onResumeExecution?.()}
                disabled={isResuming}
              >
                {isResuming ? "Resuming…" : "Resume workflow"}
              </button>
            )}
          </div>
        )}
      </div>
    </MultilinePrimaryActionScope>
  );
}
