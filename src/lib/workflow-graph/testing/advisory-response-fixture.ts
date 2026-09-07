import type {
  GraphWorkflowAdvisoryResponseInput,
  GraphWorkflowAdvisoryResponseOutcome,
} from "../advisory-response-runner";

/** A scripted implementer that explicitly declines changes to the reviewed candidate. */
export async function declineFixtureAdvisories(
  input: GraphWorkflowAdvisoryResponseInput,
): Promise<GraphWorkflowAdvisoryResponseOutcome> {
  return {
    dispositions: input.advisories.map((advisory) => ({
      identity: advisory.identity,
      disposition: "declined",
      reason: "This scenario retains the reviewed candidate.",
    })),
  };
}
