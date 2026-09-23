import type {
  DeliveryPlanAttemptView,
  DeliveryPlanNextAct,
} from "./delivery-plan-views";

/**
 * What `nextAct` needs, narrowed to values rather than the attempt row: the act
 * that follows a plan attempt is a function of its status and two policy facts,
 * so the projection stays a pure decision the hint-chain contract can walk
 * without a database (#80 design 3.6).
 */
export interface DeliveryPlanNextActInput {
  readonly status: DeliveryPlanAttemptView["status"];
  readonly specSlug: string;
  /** The managed definition the draft's authoring path is validated against. */
  readonly workflowDefinitionId: string;
  readonly builderHref: string;
  /** Whether the `execution_start` dial makes sign-off a human act. */
  readonly signOffRequiresHuman: boolean;
  /** Whether a parked attempt already carries an approval. */
  readonly parkedApproved: boolean;
}

/**
 * The server-authored half of the launch hint chain: the three attempt-status
 * rows (draft, proposed, approved) plus the states that fall out of them. The
 * receipts render this unchanged rather than restating it, so the sequence has
 * one author (#80 design 3.6).
 */
export function deliveryPlanNextAct(
  input: DeliveryPlanNextActInput,
): DeliveryPlanNextAct {
  switch (input.status) {
    case "draft":
      // The authoring path of design 3.1 and the preflight of 3.3, not the
      // binding-only write: a managed draft is a graph definition, and the
      // preflight is what reports the gate before anyone proposes.
      return {
        actor: "agent",
        command: `author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition ${input.workflowDefinitionId}`,
        reason:
          "A managed draft is authored as an ordinary plan.json; the preflight reports everything that refuses propose before you replace it.",
      };
    case "proposed":
      return {
        actor: input.signOffRequiresHuman ? "human" : "agent",
        command: input.signOffRequiresHuman
          ? `Review and sign off in Builder: ${input.builderHref}`
          : `cctl spec plan sign-off ${input.specSlug}`,
        reason: input.signOffRequiresHuman
          ? "Execution start requires human approval of the finalized launch envelope."
          : "Sign the finalized launch envelope under the execution-start policy.",
      };
    case "approved":
      return {
        actor: "agent",
        command: `cctl spec start ${input.specSlug} --file .cc/temp/inputs.json`,
        reason:
          "Write the launch parameters (or {} when none are required) to .cc/temp/inputs.json, then start the signed one-off graph launch.",
      };
    case "parked":
      return input.parkedApproved
        ? {
            actor: "agent",
            command: `cctl spec start ${input.specSlug} --file .cc/temp/inputs.json`,
            reason:
              "The signed candidate is parked for prelaunch review. Write the launch parameters (or {}) to .cc/temp/inputs.json before starting it.",
          }
        : {
            actor: input.signOffRequiresHuman ? "human" : "agent",
            command: input.signOffRequiresHuman
              ? `Review and sign off in Builder: ${input.builderHref}`
              : `cctl spec plan sign-off ${input.specSlug}`,
            reason: "The parked candidate still needs sign-off.",
          };
    case "launched":
      return {
        actor: "agent",
        command: `cctl spec status ${input.specSlug}`,
        reason: "The immutable launch is running.",
      };
    case "abandoned":
      return {
        actor: "agent",
        command: `cctl spec plan open ${input.specSlug}`,
        reason: "Open a fresh attempt.",
      };
  }
}
