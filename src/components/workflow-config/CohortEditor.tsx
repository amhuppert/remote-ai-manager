"use client";

import { agentProfileTierPresentation } from "@/components/agent-profiles/agent-profile-tier";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import type {
  ValidatorAssignment,
  ValidatorAuthority,
  ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import { ContextValidatorEditor } from "./FieldEditors";

/**
 * The one seeded reviewer, taken from the shipped defaults rather than restated.
 * A second literal here could drift from the cascade's floor, and every surface
 * that seeds a cohort (add, re-enable) would then seed a different reviewer
 * than an unconfigured workflow runs with.
 */
function seededAssignment(): ValidatorAssignment {
  const seed = SEEDED_WORKFLOW_DEFAULTS.contextValidator.assignments[0];
  if (!seed) {
    throw new Error(
      "The seeded workflow defaults carry no validator assignment to seed a cohort from.",
    );
  }
  return structuredClone(seed);
}

/**
 * A fresh use-site id that no sibling holds.
 *
 * Derived from the profile rather than a counter so the roster reads as who is
 * reviewing, and suffixed only on collision — the id is the stable identity a
 * lane, a verdict, and a reset all address, so it must survive every later edit
 * to the assignment's profile.
 */
function freshAssignmentId(taken: ReadonlySet<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Flip a cohort's `enabled` while keeping its assignments.
 *
 * Turning validation off and back on is lossless (R2): the dormant assignments
 * a disabled cohort retains are configuration to restore, not work to dispatch.
 * The one shape that cannot round-trip is an enabled cohort with no
 * assignments — an all-of decision over zero validators passes vacuously — so
 * re-enabling an empty cohort seeds the one reviewer instead.
 */
export function toggleCohortEnabled(
  cohort: ValidatorCohort,
  enabled: boolean,
): ValidatorCohort {
  const assignments =
    enabled && cohort.assignments.length === 0
      ? [seededAssignment()]
      : structuredClone(cohort.assignments);
  return { enabled, assignments };
}

/**
 * What each authority looks like in the roster.
 *
 * Blocking takes the amber consequence tone because that seat can reopen tasks
 * and fail the context; advisory stays muted because its findings only ever
 * reach the implementer as suggestions. The failure tone is deliberately not
 * used for either — red belongs to a verdict that HAS failed, not to a seat
 * that could.
 */
const AUTHORITY_PRESENTATION: Record<
  ValidatorAuthority,
  { label: string; tone: "amber" | "neutral" }
> = {
  blocking: { label: "Blocking", tone: "amber" },
  advisory: { label: "Advisory", tone: "neutral" },
};

/** Where the cohort on screen came from, and what this tier did with it. */
export type CohortCascadeState = "inherit" | "use" | "disabled";

export interface CohortCascadeProvenance {
  state: CohortCascadeState;
  /** The tier in the reader's words — "global defaults", "this context". */
  origin: string;
}

const CASCADE_PRESENTATION: Record<
  CohortCascadeState,
  { label: string; tone: "neutral" | "cyan" | "red"; preposition: string }
> = {
  inherit: { label: "Inherited", tone: "neutral", preposition: "from" },
  use: { label: "In use", tone: "cyan", preposition: "at" },
  disabled: { label: "Disabled", tone: "red", preposition: "for" },
};

export interface CohortEditorProps {
  value: ValidatorCohort;
  onChange: (next: ValidatorCohort) => void;
  /**
   * Where this cohort sits in the cascade. Absent on the tier that HAS no
   * cascade above it (the global defaults), where a provenance line would be
   * stating that a value is its own source.
   */
  cascade?: CohortCascadeProvenance;
  /** Scopes the profile listing; absent on the global-defaults form. */
  libraryProjectName?: string | null;
  /**
   * Take one member's lane back to a clean slate. Offered only where lanes
   * exist to reset (the runtime surface); a definition being authored has none.
   */
  onResetAssignment?: (assignmentId: string) => void;
  /** The assignment whose reset is in flight, if any. */
  resettingAssignmentId?: string | null;
  readOnly?: boolean;
}

const ROW_CLASS =
  "rounded-md border border-solid border-border-subtle bg-bg-surface";
const ROW_HEADER_CLASS =
  "flex flex-wrap items-center gap-[8px] border-b border-solid border-border-dim px-[12px] py-[8px]";
const ROW_ID_CLASS =
  "font-mono text-[0.72rem] font-semibold tracking-[0.04em] text-text-primary";

/**
 * The ordered validator cohort at one tier (D11).
 *
 * Order is authored, not incidental: the roster is what a frozen round is
 * dispatched against, so moving a member is a config edit like any other. A
 * disabled cohort still renders every member — the dormant set is the thing
 * re-enabling restores, and a surface that hid it would make the restore look
 * like a fresh seed.
 *
 * `enabled` is deliberately not edited here: every consumer already surfaces it
 * as a block-header switch, and a second control in the body would give one
 * flag two homes. Those switches call `toggleCohortEnabled`, which is where the
 * lossless-restore rule lives.
 */
export function CohortEditor({
  value,
  onChange,
  cascade,
  libraryProjectName,
  onResetAssignment,
  resettingAssignmentId,
  readOnly,
}: CohortEditorProps): React.JSX.Element {
  const dormant = !value.enabled;
  // Dormant members are configuration to restore, not to revise: editing them
  // in place would be editing what nothing is running, and the flag that would
  // put them back is one control away.
  const locked = readOnly === true || dormant;
  const canRemove = !locked && value.assignments.length > 1;

  const replaceAt = (index: number, next: ValidatorAssignment) => {
    onChange({
      ...value,
      assignments: value.assignments.map((current, currentIndex) =>
        currentIndex === index ? next : current,
      ),
    });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.assignments.length) return;
    const assignments = [...value.assignments];
    const [moved] = assignments.splice(index, 1);
    if (!moved) return;
    assignments.splice(target, 0, moved);
    onChange({ ...value, assignments });
  };

  const remove = (index: number) => {
    onChange({
      ...value,
      assignments: value.assignments.filter(
        (_current, currentIndex) => currentIndex !== index,
      ),
    });
  };

  const add = () => {
    const seed = seededAssignment();
    const taken = new Set(value.assignments.map((entry) => entry.id));
    onChange({
      ...value,
      assignments: [
        ...value.assignments,
        {
          ...seed,
          id: freshAssignmentId(taken, seed.profile.id),
        },
      ],
    });
  };

  return (
    <div
      className="flex flex-col gap-md"
      data-testid="cohort-editor"
      data-cohort-enabled={value.enabled ? "true" : "false"}
    >
      {cascade ? (
        <div
          data-testid="cohort-cascade"
          data-cascade-state={cascade.state}
          className="flex items-center gap-[6px] font-mono text-[0.7rem] text-text-tertiary"
        >
          <StatusChip tone={CASCADE_PRESENTATION[cascade.state].tone}>
            {CASCADE_PRESENTATION[cascade.state].label}
          </StatusChip>
          <span>
            {CASCADE_PRESENTATION[cascade.state].preposition} {cascade.origin}
          </span>
        </div>
      ) : null}

      {dormant && value.assignments.length > 0 ? (
        <p
          data-testid="cohort-dormant-notice"
          className="text-[0.72rem] leading-[1.5] text-text-secondary"
        >
          Validation is off. These {value.assignments.length} assignment
          {value.assignments.length === 1 ? "" : "s"} stay dormant and return,
          in this order, when you turn it back on.
        </p>
      ) : null}

      {value.assignments.map((assignment, index) => {
        const tier = agentProfileTierPresentation(assignment.profile.tier);
        const authority = AUTHORITY_PRESENTATION[assignment.authority];
        return (
          <div
            key={assignment.id}
            className={cn(ROW_CLASS, dormant && "opacity-70")}
            data-testid={`cohort-assignment-${assignment.id}`}
            data-assignment-id={assignment.id}
            data-dormant={dormant ? "true" : "false"}
          >
            <div className={ROW_HEADER_CLASS}>
              <span className={ROW_ID_CLASS}>{assignment.id}</span>
              <StatusChip
                tone={tier.tone}
                appearance="flat"
                data-testid="cohort-tier-badge"
              >
                {tier.label}
              </StatusChip>
              <StatusChip
                tone={authority.tone}
                appearance="flat"
                data-testid="cohort-authority-badge"
                data-authority={assignment.authority}
              >
                {authority.label}
              </StatusChip>
              {dormant ? (
                <StatusChip tone="amber" appearance="flat">
                  Dormant
                </StatusChip>
              ) : null}
              <div className="ml-auto flex items-center gap-[2px]">
                <Button
                  variant="ghost"
                  size="sm"
                  touch
                  type="button"
                  aria-label={`Move ${assignment.id} up`}
                  disabled={locked || index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  touch
                  type="button"
                  aria-label={`Move ${assignment.id} down`}
                  disabled={locked || index === value.assignments.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                {onResetAssignment ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    touch
                    type="button"
                    aria-label={`Reset ${assignment.id}`}
                    title="Retire this validator's lane and re-run it against the current candidate"
                    loading={resettingAssignmentId === assignment.id}
                    disabled={readOnly}
                    onClick={() => onResetAssignment(assignment.id)}
                  >
                    Reset
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  touch
                  type="button"
                  aria-label={`Remove ${assignment.id}`}
                  title={
                    canRemove
                      ? undefined
                      : "An enabled cohort needs at least one validator — validation over an empty cohort would pass vacuously."
                  }
                  disabled={!canRemove}
                  onClick={() => remove(index)}
                >
                  Remove
                </Button>
              </div>
            </div>
            <div className="p-[12px]">
              <ContextValidatorEditor
                value={assignment}
                onChange={(next) => replaceAt(index, next)}
                libraryProjectName={libraryProjectName}
                readOnly={locked}
              />
            </div>
          </div>
        );
      })}

      <div>
        <Button
          variant="ghost"
          size="sm"
          touch
          type="button"
          disabled={locked}
          onClick={add}
        >
          Add validator
        </Button>
      </div>
    </div>
  );
}
