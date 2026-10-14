/**
 * The sentences refusals use to say their friction is the product rather than
 * a defect (agent-operability slice design §11).
 *
 * Each one asserts the value instead of apologizing: an agent told a rule is
 * unfortunate goes looking for the way around it, while an agent told what the
 * rule protects can weigh it. They live here rather than at each producer so
 * one code cannot explain itself two different ways across the surfaces that
 * issue it — `human_act_required` alone is raised from six transition
 * predicates, the review service, the plan service, and the route gate.
 *
 * Imports only the refusal-code type, so every specs module that issues a
 * refusal can read it.
 */

import type { RefusalCode } from "./schemas";

/**
 * Why the agent surface cannot perform a human act. Names the whole class, so
 * the reader learns the boundary from whichever member they hit first.
 */
export const HUMAN_ACT_REQUIRED_RATIONALE =
  "approval, sign-off, question answers, assumption dispositions, and thread resolution are human judgments the agent surface must not perform";

/** Why staged authoring refuses a later stage's element in an earlier stage. */
export const LATER_STAGE_RATIONALE =
  "requirements settle before design so solution choices cannot shape the contract around themselves";

/** Why a delivery plan cannot be authored inside an evergreen revision. */
export const PLAN_IN_EVERGREEN_RATIONALE =
  "legacy Plan revisions and task elements remain read-only history; requirements and design are the authoring contract";

/** Why an element the revision carries cannot be moved to another parent. */
export const PARENT_IMMUTABLE_RATIONALE =
  "containment is identity: a moved element would retroactively change what every frozen revision contained";

/** Why an approval refuses once the draft moved under the reviewer. */
export const STALE_REVIEW_RATIONALE =
  "an approval records the content a human read, and the author changed the draft after they read it";

const RATIONALE_BY_CODE: Partial<Record<RefusalCode, string>> = {
  human_act_required: HUMAN_ACT_REQUIRED_RATIONALE,
  stale_review: STALE_REVIEW_RATIONALE,
};

/**
 * The rationale a code carries wherever it is raised, for the generic refusal
 * constructors that only know the code. Undefined when the reason is
 * site-specific (`stage_blocked` has one sentence per branch) or when the
 * unmet condition already carries its own.
 */
export function rationaleForCode(code: RefusalCode): string | undefined {
  return RATIONALE_BY_CODE[code];
}
