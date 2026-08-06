import type { WorkflowDefaults } from "@/lib/config/schemas";
import { ConfigSubsection } from "../components/ConfigSubsection";
import { SettingsPage } from "../components/SettingsPage";
import { deepEqual, SEEDED_WORKFLOW_DEFAULTS } from "../form-state";
import type { ConfigFormController } from "./types";
import { AskUserQuestionsFields } from "./workflow/AskUserQuestionsFields";
import { CircuitBreakerFields } from "./workflow/CircuitBreakerFields";
import { CollaborationFields } from "./workflow/CollaborationFields";
import { ContextValidatorFields } from "./workflow/ContextValidatorFields";
import { ImplementerFields } from "./workflow/ImplementerFields";
import { IterationPolicyFields } from "./workflow/IterationPolicyFields";
import { MutabilityFields } from "./workflow/MutabilityFields";
import { PlanRepairFields } from "./workflow/PlanRepairFields";
import { ScriptValidatorFields } from "./workflow/ScriptValidatorFields";

export function WorkflowSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChangeBlock } = controller;
  return (
    <SettingsPage
      title="Workflow"
      accent="defaults"
      sub="Per-stage configuration used by every new graph workflow."
    >
      <WorkflowDefaultsSubsections
        defaults={formState.workflowDefaults}
        onChangeBlock={handleChangeBlock}
      />
    </SettingsPage>
  );
}

function WorkflowDefaultsSubsections({
  defaults,
  onChangeBlock,
}: {
  defaults: WorkflowDefaults | undefined;
  onChangeBlock: ConfigFormController["handleChangeBlock"];
}) {
  const effective: WorkflowDefaults = defaults ?? SEEDED_WORKFLOW_DEFAULTS;

  const implementerIsDefault = deepEqual(
    effective.implementer,
    SEEDED_WORKFLOW_DEFAULTS.implementer,
  );
  const validatorIsDefault = deepEqual(
    effective.contextValidator,
    SEEDED_WORKFLOW_DEFAULTS.contextValidator,
  );
  const scriptValidatorIsDefault = deepEqual(
    effective.scriptValidator,
    SEEDED_WORKFLOW_DEFAULTS.scriptValidator,
  );
  const askUserQuestionsIsDefault = deepEqual(
    effective.askUserQuestions,
    SEEDED_WORKFLOW_DEFAULTS.askUserQuestions,
  );
  const iterationIsDefault = deepEqual(
    effective.iterationPolicy,
    SEEDED_WORKFLOW_DEFAULTS.iterationPolicy,
  );
  const circuitIsDefault = deepEqual(
    effective.circuitBreaker,
    SEEDED_WORKFLOW_DEFAULTS.circuitBreaker,
  );
  const mutabilityIsDefault = deepEqual(
    effective.mutability,
    SEEDED_WORKFLOW_DEFAULTS.mutability,
  );
  const planRepairIsDefault = deepEqual(
    effective.planRepair,
    SEEDED_WORKFLOW_DEFAULTS.planRepair,
  );
  const collaborationIsDefault = deepEqual(
    effective.collaboration,
    SEEDED_WORKFLOW_DEFAULTS.collaboration,
  );

  return (
    <>
      <ConfigSubsection
        id="implementer"
        title="Implementer"
        isDefault={implementerIsDefault}
      >
        <ImplementerFields
          value={effective.implementer.agent}
          onChange={(agent) =>
            onChangeBlock("implementer", { ...effective.implementer, agent })
          }
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="collaboration"
        title="Collaboration"
        isDefault={collaborationIsDefault}
      >
        <CollaborationFields
          value={effective.collaboration}
          onChange={(v) => onChangeBlock("collaboration", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="contextValidator"
        title="Context validator"
        isDefault={validatorIsDefault}
      >
        <ContextValidatorFields
          value={effective.contextValidator}
          onChange={(v) => onChangeBlock("contextValidator", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="scriptValidator"
        title="Script validator"
        isDefault={scriptValidatorIsDefault}
      >
        <ScriptValidatorFields
          value={effective.scriptValidator}
          onChange={(v) => onChangeBlock("scriptValidator", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="askUserQuestions"
        title="Ask user questions"
        isDefault={askUserQuestionsIsDefault}
      >
        <AskUserQuestionsFields
          value={effective.askUserQuestions}
          onChange={(v) => onChangeBlock("askUserQuestions", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="iterationPolicy"
        title="Iteration policy"
        isDefault={iterationIsDefault}
      >
        <IterationPolicyFields
          value={effective.iterationPolicy}
          onChange={(v) => onChangeBlock("iterationPolicy", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="circuitBreaker"
        title="Circuit breaker"
        isDefault={circuitIsDefault}
      >
        <CircuitBreakerFields
          value={effective.circuitBreaker}
          onChange={(v) => onChangeBlock("circuitBreaker", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="planRepair"
        title="Plan repair"
        isDefault={planRepairIsDefault}
      >
        <PlanRepairFields
          value={effective.planRepair}
          onChange={(v) => onChangeBlock("planRepair", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="mutability"
        title="Mutability"
        isDefault={mutabilityIsDefault}
      >
        <MutabilityFields
          value={effective.mutability}
          onChange={(v) => onChangeBlock("mutability", v)}
        />
      </ConfigSubsection>
    </>
  );
}
