import type { GraphWorkflowExecution } from "./schemas";
import type { RepoValidationConfig } from "@/lib/validation/schemas";
import { criterionRecordsOf } from "./criteria/criterion-records";
import { assignmentFingerprint } from "./lane-identity";
import { reconcileValidationRoster } from "./validation-round";
import { renderCharterPromptSection } from "./charter/render";
import {
  resolveLogicalAuthoredContextId,
  resolveScopedCharterForContext,
} from "./charter/invariant-scope";
import { buildValidatorRoleContract } from "./role-instructions";
import {
  buildValidatorOutputSchema,
  issueCriterionCitationFor,
} from "./validator-output-schema";
import {
  buildValidationCommandsSection,
  buildValidatorDeterministicChecksGuidance,
  loadValidationPromptRegistry,
  resolveValidationPromptSelections,
} from "./validation-prompt-section";

export interface ValidatorRuntimeInstructionDependencies {
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  readValidationConfig(
    projectPath: string,
  ): Promise<RepoValidationConfig | null | undefined>;
}

/** The durable lane selects the role; caller-authored prompts cannot grant it. */
export function createValidatorRuntimeInstructionReader(
  deps: ValidatorRuntimeInstructionDependencies,
) {
  return async (input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<string | null> => {
    const execution = await deps.getActiveExecution(
      input.projectPath,
      input.sessionName,
    );
    if (!execution) return null;
    const lane = Object.values(execution.laneStates)
      .flatMap((lanes) => Object.values(lanes))
      .find(
        (lane) =>
          lane.lane === "context_validator" &&
          lane.workflowConversationId === input.conversationId,
      );
    if (!lane) return null;

    const context = execution.workingDefinition.executionContexts.find(
      (context) => context.id === lane.contextId,
    );
    const assignment = context?.contextValidator.assignments.find(
      (assignment) => assignment.id === lane.assignmentId,
    );
    if (!context || !assignment) {
      throw new Error("Validator lane has no configured assignment");
    }
    if (
      lane.assignmentFingerprint !== undefined &&
      lane.assignmentFingerprint !== assignmentFingerprint(assignment)
    ) {
      throw new Error(
        "Validator lane assignment changed after its conversation was created",
      );
    }
    const round = execution.contextStates[context.id]?.validationRound;
    if (round && round.phase !== "concluded") {
      const roster = reconcileValidationRoster(
        round.roster.filter((seat) => seat.assignmentId === assignment.id),
        [assignment],
      );
      if (roster.kind === "drift") {
        throw new Error(
          `Validator assignment changed after the review roster was frozen: ${roster.detail}`,
        );
      }
    }

    const selections = resolveValidationPromptSelections({
      role: "contextValidator",
      context,
      registry: await loadValidationPromptRegistry(() =>
        deps.readValidationConfig(input.projectPath),
      ),
    });
    const charter = context.charter
      ? renderCharterPromptSection(
          resolveScopedCharterForContext({
            execution,
            contextId: context.id,
            charter: context.charter,
          }),
          resolveLogicalAuthoredContextId({
            execution,
            contextId: context.id,
          }) ?? context.id,
        )
      : null;
    const verdictSchema = buildValidatorOutputSchema({
      authority: assignment.authority,
      taskIds: execution.workingDefinition.tasks
        .filter((task) => task.contextId === context.id)
        .sort((left, right) => left.order - right.order)
        .map((task) => task.id),
      criterionIds: criterionRecordsOf(context.acceptanceCriteria).map(
        (criterion) => criterion.id,
      ),
      issueCriterionCitation: issueCriterionCitationFor(assignment),
    });
    return [
      charter,
      buildValidationCommandsSection(selections),
      buildValidatorDeterministicChecksGuidance(selections),
      buildValidatorRoleContract(
        assignment.authority === "advisory"
          ? { authority: "advisory", verdictSchema }
          : {
              authority: "blocking",
              verdictSchema,
              ...(assignment.focus === undefined
                ? {}
                : { mandate: assignment.focus }),
            },
      ),
    ]
      .filter((section): section is string => section !== null)
      .join("\n\n");
  };
}
