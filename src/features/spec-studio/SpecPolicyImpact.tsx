"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { remainingAuthoringSequence } from "@/lib/specs/authoring-sequence";
import {
  COMBINED_APPROVAL_DIAL,
  dialRequiresHumanApproval,
  resolveDial,
} from "@/lib/specs/policy";
import type { SpecDetailView } from "@/lib/specs/queries";
import { toDiffRows } from "@/lib/specs/review-state";
import type { RevisionElement } from "@/lib/specs/revision-diff";
import {
  specGateSchema,
  type ResolvedGateDial,
  type SpecAuthoringStage,
  type SpecGate,
  type SpecGatePolicy,
} from "@/lib/specs/schemas";
import type { RemainingAuthoringSequence } from "@/lib/specs/view-schemas";

import { gateLabels } from "./presentation";

/**
 * The open draft a policy change would land on, in the shape
 * `remainingAuthoringSequence` consumes. The pinned stage is taken from the
 * server's own sequence rather than re-derived here, and the element rows come
 * with it because the stage-scoped consultation of R10.11 depends on what the
 * draft changed — under the *proposed* dials, which no stored projection can
 * have computed yet.
 */
export interface PolicyImpactDraft {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly pinnedStage: SpecAuthoringStage;
  readonly baseRevisionRows: readonly RevisionElement[];
  readonly revisionRows: readonly RevisionElement[];
}

export type PolicyImpactApprovalEffect = "added" | "removed" | "unaffected";

export interface PolicyImpactGateChange {
  readonly gate: SpecGate;
  readonly currentDial: ResolvedGateDial;
  readonly proposedDial: ResolvedGateDial;
  readonly approval: PolicyImpactApprovalEffect;
}

export interface PolicyImpactLifecycleStep {
  readonly gate: SpecGate;
  readonly dial: ResolvedGateDial;
}

export interface PolicyChangeImpact {
  /** The draft's sequence under the proposed dials; null with no open draft. */
  readonly sequence: RemainingAuthoringSequence | null;
  readonly gateChanges: readonly PolicyImpactGateChange[];
  readonly remainingLifecycle: readonly PolicyImpactLifecycleStep[];
}

/**
 * Reads the open draft out of a spec detail view. `status.authoringSequence`
 * is the server's statement that a draft is open and which stage it is pinned
 * at, so its absence — not a local revision-state rule — is what makes the
 * preview report no draft.
 */
export function openDraftForPolicyImpact(
  detail: SpecDetailView,
): PolicyImpactDraft | null {
  const sequence = detail.status.authoringSequence;
  const snapshot = detail.currentRevision;
  if (
    sequence === null ||
    snapshot === null ||
    snapshot.revision.id !== sequence.revisionId
  ) {
    return null;
  }
  return {
    revisionId: sequence.revisionId,
    revisionNumber: sequence.revisionNumber,
    pinnedStage: sequence.pinnedStage,
    baseRevisionRows:
      detail.baseRevision === null ? [] : toDiffRows(detail.baseRevision),
    revisionRows: toDiffRows(snapshot),
  };
}

function approvalEffect(
  currentDial: ResolvedGateDial,
  proposedDial: ResolvedGateDial,
): PolicyImpactApprovalEffect {
  const before = dialRequiresHumanApproval(currentDial);
  const after = dialRequiresHumanApproval(proposedDial);
  if (before === after) return "unaffected";
  return after ? "added" : "removed";
}

export function policyChangeImpact(
  currentPolicy: SpecGatePolicy,
  proposedPolicy: SpecGatePolicy,
  draft: PolicyImpactDraft | null,
): PolicyChangeImpact {
  const sequence =
    draft === null
      ? null
      : remainingAuthoringSequence({ policy: proposedPolicy, ...draft });
  return {
    sequence,
    gateChanges: specGateSchema.options.map((gate) => {
      const currentDial = resolveDial(currentPolicy, gate);
      const proposedDial = resolveDial(proposedPolicy, gate);
      return {
        gate,
        currentDial,
        proposedDial,
        approval: approvalEffect(currentDial, proposedDial),
      };
    }),
    // The domain sequence covers authoring only; execution start and delivery
    // still bound the draft's lifecycle, so they close the list under the same
    // proposed dials.
    remainingLifecycle:
      sequence === null
        ? []
        : [
            ...sequence.stages.map(({ gate, dial }) => ({ gate, dial })),
            {
              gate: "execution_start" as const,
              dial: resolveDial(proposedPolicy, "execution_start"),
            },
            {
              gate: "delivery" as const,
              dial: resolveDial(proposedPolicy, "delivery"),
            },
          ],
  };
}

const dialLabels: Record<ResolvedGateDial, string> = {
  gate: "Gate",
  notify: "Notify",
  off: "Off",
  [COMBINED_APPROVAL_DIAL]: "Combined approval",
};

const approvalListLabels: Record<PolicyImpactApprovalEffect, string> = {
  added: "Approvals added",
  removed: "Approvals removed",
  unaffected: "Approvals unaffected",
};

const approvalTones: Record<PolicyImpactApprovalEffect, StatusChipTone> = {
  added: "cyan",
  removed: "amber",
  unaffected: "neutral",
};

// Only one policy confirmation is open at a time, so a constant id is safe.
const IMPACT_HEADING_ID = "spec-policy-impact-heading";

const termClass =
  "font-mono text-[0.62rem] font-bold tracking-[0.08em] text-text-tertiary uppercase";
const valueClass =
  "m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary";

function ChipList({
  label,
  tone,
  items,
}: {
  label: string;
  tone: StatusChipTone;
  items: readonly { key: string; text: string }[];
}): React.JSX.Element {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-wrap gap-xs p-0">
      {items.map((item) => (
        <li key={item.key}>
          <StatusChip tone={tone} wrap>
            {item.text}
          </StatusChip>
        </li>
      ))}
    </ul>
  );
}

function ApprovalGroup({
  effect,
  changes,
}: {
  effect: PolicyImpactApprovalEffect;
  changes: readonly PolicyImpactGateChange[];
}): React.JSX.Element | null {
  const matching = changes.filter((change) => change.approval === effect);
  if (matching.length === 0) return null;
  return (
    <ChipList
      label={approvalListLabels[effect]}
      tone={approvalTones[effect]}
      items={matching.map((change) => ({
        key: change.gate,
        text: `${gateLabels[change.gate]} · ${dialLabels[change.currentDial]} → ${dialLabels[change.proposedDial]}`,
      }))}
    />
  );
}

/**
 * What the confirmed change will actually do, shown inside the confirmation
 * the server's own predicate opens. Every claim is prospective: the change
 * pins an open draft's stage (R25.1) and governs only the transitions still
 * ahead of it (R25.2), so the preview never implies a restage.
 */
export function PolicyImpactPreview({
  currentPolicy,
  proposedPolicy,
  draft,
}: {
  currentPolicy: SpecGatePolicy;
  proposedPolicy: SpecGatePolicy;
  draft: PolicyImpactDraft | null;
}): React.JSX.Element {
  const impact = policyChangeImpact(currentPolicy, proposedPolicy, draft);
  const sequence = impact.sequence;
  const stageLabel =
    sequence === null ? null : gateLabels[sequence.pinnedStage];

  return (
    <section
      aria-labelledby={IMPACT_HEADING_ID}
      // Capped and scrollable so a long preview never pushes the confirm and
      // cancel actions out of a short viewport.
      className="my-md max-h-[42vh] overflow-y-auto rounded-md border border-solid border-border-subtle bg-bg-base px-md py-sm"
    >
      <h3
        id={IMPACT_HEADING_ID}
        className="mt-0 mb-sm font-mono text-[0.62rem] font-bold tracking-[0.1em] text-text-tertiary uppercase"
      >
        Impact of this change
      </h3>
      <dl className="m-0 grid grid-cols-[132px_minmax(0,1fr)] items-baseline gap-x-md gap-y-sm max-768:grid-cols-1 max-768:gap-y-xs">
        <dt className={termClass}>Authoring stage</dt>
        <dd className="m-0">
          {sequence === null || stageLabel === null ? (
            <p className={valueClass}>
              No open draft revision — the new dials govern every transition
              from the next draft onward.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-sm">
                <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
                  {`${stageLabel} → ${stageLabel}`}
                </span>
                <StatusChip tone="cyan">Pinned</StatusChip>
              </div>
              <p className={`${valueClass} mt-[2px]`}>
                A policy change never restages an open draft: rev{" "}
                {sequence.revisionNumber} keeps its {stageLabel} stage until an
                ordinary recorded transition moves it.
              </p>
            </>
          )}
        </dd>

        {sequence !== null && (
          <>
            <dt className={termClass}>Next transition</dt>
            <dd className="m-0 grid gap-xs">
              <p className={valueClass}>
                {sequence.nextTransition.action === "advance"
                  ? "Advance"
                  : "Propose"}{" "}
                the {gateLabels[sequence.nextTransition.stage]} stage —{" "}
                {sequence.nextTransition.requiresHumanSignOff
                  ? "human sign-off required"
                  : "the agent may proceed"}
                .
              </p>
              <ChipList
                label="Gates the next transition consults"
                tone="neutral"
                items={sequence.nextTransition.consultedGates.map(
                  ({ gate, dial }) => ({
                    key: gate,
                    text: `${gateLabels[gate]} · ${dialLabels[dial]}`,
                  }),
                )}
              />
            </dd>
          </>
        )}

        <dt className={termClass}>Approvals</dt>
        <dd className="m-0 grid gap-xs">
          <ApprovalGroup effect="added" changes={impact.gateChanges} />
          <ApprovalGroup effect="removed" changes={impact.gateChanges} />
          <ApprovalGroup effect="unaffected" changes={impact.gateChanges} />
        </dd>

        {sequence !== null && stageLabel !== null && (
          <>
            <dt className={termClass}>Draft validity</dt>
            <dd className="m-0">
              <p className={valueClass}>
                Draft rev {sequence.revisionNumber} stays valid — pinning the
                stage keeps every element it already holds admissible, and no
                approval or admission is created for a transition that already
                happened.
              </p>
            </dd>

            <dt className={termClass}>Remaining lifecycle</dt>
            <dd className="m-0">
              <ChipList
                label="Remaining lifecycle"
                tone="neutral"
                items={impact.remainingLifecycle.map((step) => ({
                  key: step.gate,
                  text: `${gateLabels[step.gate]} · ${dialLabels[step.dial]}`,
                }))}
              />
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
