import type {
  DeliveryPlanAttemptView,
  DeliveryPlanNextAct,
} from "./delivery-plan-views";

/**
 * What `nextAct` needs, narrowed to values rather than the attempt row: the act
 * that follows a plan attempt is a function of its status, whether its draft
 * is ready for sign-off, and one policy fact, so the projection stays a pure
 * decision the hint-chain contract can walk without a database (#80 design
 * 3.6).
 */
export interface DeliveryPlanNextActInput {
  readonly status: DeliveryPlanAttemptView["status"];
  readonly specSlug: string;
  /** The managed definition the draft's authoring path is validated against. */
  readonly workflowDefinitionId: string;
  readonly builderHref: string;
  /** Whether the `execution_start` dial makes sign-off a human act. */
  readonly signOffRequiresHuman: boolean;
  /** Whether the draft has no finding that blocks sign-off. */
  readonly draftReady: boolean;
}

/**
 * The server-authored half of the launch hint chain. The receipts render this
 * unchanged rather than restating it, so the sequence has one author (#80
 * design 3.6).
 */
export function deliveryPlanNextAct(
  input: DeliveryPlanNextActInput,
): DeliveryPlanNextAct {
  switch (input.status) {
    case "draft":
      if (!input.draftReady) {
        // The authoring path of design 3.1 and the preflight of 3.3: a managed
        // draft is a graph definition, and the preflight reports every
        // finding that blocks sign-off.
        return {
          actor: "agent",
          command: `author .cc/temp/plan.json with the graph-workflow-planning skill, then cctl workflow validate --file .cc/temp/plan.json --definition ${input.workflowDefinitionId}`,
          reason:
            "A managed draft is authored as an ordinary plan.json; the preflight reports everything that blocks sign-off before you replace it.",
        };
      }
      return input.signOffRequiresHuman
        ? {
            actor: "human",
            command: `Review and sign off in Builder: ${input.builderHref}`,
            reason:
              "Execution start requires a human to review the draft and sign it off; sign-off freezes the exact launch envelope.",
          }
        : {
            actor: "agent",
            command: `cctl spec plan propose ${input.specSlug}`,
            reason:
              "The execution-start policy admits the draft without a human, so propose freezes and signs the launch envelope.",
          };
    case "approved":
      return {
        actor: "agent",
        command: `cctl spec start ${input.specSlug} --file .cc/temp/inputs.json`,
        reason:
          "Write the launch parameters (or {} when none are required) to .cc/temp/inputs.json, then start the signed one-off graph launch.",
      };
    case "parked":
      return {
        actor: "agent",
        command: `cctl spec start ${input.specSlug} --file .cc/temp/inputs.json`,
        reason:
          "The signed candidate is parked for prelaunch review. Write the launch parameters (or {}) to .cc/temp/inputs.json before starting it.",
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
