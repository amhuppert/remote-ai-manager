import { createLogger } from "@/lib/logging";
import {
  locateAuthoredAccountabilityCoverageCore,
  type AuthoredAccountabilityCoverageInput,
  type LocatedAuthoredAccountabilityCoverage,
} from "./authored-accountability-coverage-core";

const logger = createLogger("workflow-graph-authored-accountability-coverage");

export type {
  AuthoredAccountabilityCoverageGroup,
  AuthoredAccountabilityCoverageInput,
  LocatedAuthoredAccountabilityCoverage,
} from "./authored-accountability-coverage-core";

export function locateAuthoredAccountabilityCoverage(
  input: AuthoredAccountabilityCoverageInput,
): LocatedAuthoredAccountabilityCoverage[] {
  const located = locateAuthoredAccountabilityCoverageCore(input);
  logger.debug("graph-workflow.authored-accountability-coverage.located", {
    sourceKind: input.source.kind,
    groupCount: located.length,
    coveredGroupCount: located.filter((group) => group.covered).length,
    uncoveredGroupCount: located.filter((group) => !group.covered).length,
  });
  return located;
}
