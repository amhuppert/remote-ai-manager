"use client";

import {
  ApprovalGlyphIcon,
  BackendChip,
  GateChip,
  QuestionGlyphIcon,
  ScriptGlyphIcon,
  implementerChipLabel,
  validatorChipLabel,
} from "@/components/workflow-config/InspectorChips";
import {
  formatAgentProfileRef,
  type AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The selected context's resolved setup, read-only: the at-a-glance chip row
 * under the header, rendered straight from the execution's already-resolved
 * working definition — no cascade logic client-side.
 *
 * A historical run's full configuration is no longer a JSON dump beside this
 * strip: the Config tab mounts the same panel in its read-only affordance, so
 * one surface renders the configuration in every tenure (README §11).
 */

type ResolvedContextDefinition =
  GraphWorkflowExecution["workingDefinition"]["executionContexts"][number];

// `tier:id@revision` for a seeded assignment. The snapshot is the side that
// ran: after the library moves on, only these bytes identify what the lane was
// actually given.
function seededProfileLabel(snapshot: AgentProfileSnapshot): string {
  return `${formatAgentProfileRef(snapshot)}@${snapshot.revision}`;
}

// At-a-glance summary of the selected context's resolved configuration:
// implementer + enabled gates as compact chips. Everything renders straight
// from the execution's already-resolved working definition.
export function ResolvedSetupStrip({
  context,
}: {
  context: ResolvedContextDefinition;
}): React.JSX.Element {
  const cohort = context.contextValidator;
  const hasScriptGate = context.scriptValidator.commands.length > 0;
  return (
    <div
      className="flex flex-shrink-0 flex-wrap items-center gap-[6px] border-b border-solid border-border-dim bg-bg-base px-lg py-[10px]"
      data-section="resolved-setup"
    >
      <BackendChip backend={context.implementer.agent.backend}>
        {/* The implementer's PROFILE identity, not just its runtime: after a
            library edit only the seeded revision says which instructions this
            context's implementer actually received (R12.3). */}
        <span data-testid="setup-implementer-profile">
          {seededProfileLabel(context.implementer.profileSnapshot)}
        </span>
        {" · "}
        {implementerChipLabel(context.implementer.agent)}
      </BackendChip>
      {cohort.enabled
        ? cohort.assignments.map((assignment) => (
            <BackendChip key={assignment.id} backend={assignment.agent.backend}>
              Validator · {validatorChipLabel(assignment)}
            </BackendChip>
          ))
        : null}
      {hasScriptGate ? (
        <GateChip tone="neutral" icon={<ScriptGlyphIcon size={13} />}>
          Script
        </GateChip>
      ) : null}
      {context.humanApprovalGate.enabled ? (
        <GateChip tone="amber" icon={<ApprovalGlyphIcon size={13} />}>
          Approval
        </GateChip>
      ) : null}
      {context.askUserQuestions.enabled ? (
        <GateChip tone="amber" icon={<QuestionGlyphIcon size={13} />}>
          Questions
        </GateChip>
      ) : null}
    </div>
  );
}
