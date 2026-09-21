import { z } from "zod";
import { workflowValidatorOutputPlanDefectSchema } from "./definition-schemas";
import {
  isAcceptanceCriteriaValidatorProfile,
  type ValidatorAssignment,
  type ValidatorAuthority,
} from "./config-schemas";

/**
 * The advisory item both authorities emit, closed to anything else. No
 * `taskId`: an advisory is addressed to the implementer rather than to a task
 * the engine must reopen.
 */
const ADVISORY_ITEMS_OUTPUT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["implementation", "plan", "out_of_scope"],
      },
      title: { type: "string" },
      description: { type: "string" },
    },
    required: ["kind", "title", "description"],
    additionalProperties: false,
  },
} as const;

/**
 * The plan-defect item only a blocking seat may emit: the contract itself is
 * unsatisfiable here, so there is nothing to reopen.
 *
 * Projected from the Zod contract rather than hand-written, so the gate the
 * provider enforces and the twin the runner parses cannot drift: the four
 * fields, their non-emptiness, and the closed object all have one source. The
 * absence of a `taskId` property is what makes this response structurally
 * distinct from an issue rather than a differently-worded one.
 *
 * `$schema` is dropped because this is embedded as a SUBSCHEMA of the dispatched
 * validator schema, where a nested dialect declaration is a keyword the
 * provider's schema validator never asked for.
 */
const { $schema: _planDefectDialect, ...PLAN_DEFECT_ITEMS_OUTPUT_SCHEMA } =
  z.toJSONSchema(z.array(workflowValidatorOutputPlanDefectSchema));

/**
 * The structured-output schema for one validator dispatch, selected by the
 * seat's authority and bound to the context it is reviewing.
 *
 * Two properties are load-bearing. Authority is STRUCTURAL: neither `issues`
 * nor `planDefects` appears in the advisory schema, so a validator with no
 * blocking authority can neither fail a context nor route one to plan repair —
 * the attempt fails the output gate and retries rather than reaching the engine
 * as a verdict. And `taskId` is an enum of this context's task ids, so an id the
 * validator invented is caught at the same gate, where a retry can fix it,
 * instead of arriving as a well-formed verdict the runner can only reject as an
 * infrastructure failure.
 *
 * `planDefects` is the one optional field on the verdict: `issues` and
 * `advisories` stay required because their empty arrays carry meaning (a
 * pass, and a considered absence of observations), while requiring the rare
 * third response would make every clean verdict declare it.
 *
 * `criterionId` is bound to the context's criterion-record ids exactly as
 * `taskId` is bound to its task ids, and the citation rule decides whether an
 * issue must carry it (#69 change 4 seat table): the acceptance seat judges
 * the criteria themselves, so its issues cite one; a specialist's blocking
 * basis is its assigned mandate, so a criterion id appears only when a
 * mandate finding also contradicts a specific criterion.
 */
export function buildValidatorOutputSchema(input: {
  authority: ValidatorAuthority;
  taskIds: readonly string[];
  criterionIds: readonly string[];
  issueCriterionCitation: IssueCriterionCitation;
}): Record<string, unknown> {
  if (input.authority === "advisory") {
    return {
      type: "object",
      properties: {
        summary: { type: "string" },
        advisories: ADVISORY_ITEMS_OUTPUT_SCHEMA,
      },
      required: ["summary", "advisories"],
      additionalProperties: false,
    };
  }

  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // An empty enum matches nothing and providers refuse it outright,
            // so a context with no ids to name falls back to a free-form
            // field rather than dispatching an unsatisfiable schema.
            taskId: {
              type: "string",
              ...(input.taskIds.length > 0 ? { enum: [...input.taskIds] } : {}),
            },
            criterionId: {
              type: "string",
              ...(input.criterionIds.length > 0
                ? { enum: [...input.criterionIds] }
                : {}),
            },
            title: { type: "string" },
            description: { type: "string" },
          },
          required:
            input.issueCriterionCitation === "required"
              ? ["taskId", "criterionId", "title", "description"]
              : ["taskId", "title", "description"],
          additionalProperties: false,
        },
      },
      advisories: ADVISORY_ITEMS_OUTPUT_SCHEMA,
      planDefects: PLAN_DEFECT_ITEMS_OUTPUT_SCHEMA,
    },
    required: ["summary", "issues", "advisories"],
    additionalProperties: false,
  };
}

/**
 * Whether a seat's blocking issues must each cite a criterion id, derived
 * from what the seat is assigned to judge: the default blocking
 * general-reviewer (the acceptance seat) judges the criteria themselves, so
 * its citation is required; every other seat cites its own mandate and
 * carries a criterion id only incidentally. Advisory seats emit no issues at
 * all, so the value is inert for them.
 */
export type IssueCriterionCitation = "required" | "optional";

export function issueCriterionCitationFor(
  validator: Pick<ValidatorAssignment, "authority" | "profile">,
): IssueCriterionCitation {
  return validator.authority === "blocking" &&
    isAcceptanceCriteriaValidatorProfile(validator.profile)
    ? "required"
    : "optional";
}
