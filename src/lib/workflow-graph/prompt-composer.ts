import type { GraphWorkflowExecution } from "./schemas";
import {
  createRegisteredGraphExecutionContract,
  type GraphExecutionContract,
} from "./execution-contract-port";

/**
 * A launching tier's bounded, immutable prompt projection. The graph composer
 * owns placement and authority framing while the launching tier owns the body.
 */
export interface GraphRolePromptProjection {
  heading: string;
  body: string;
}

export function renderGraphRolePromptProjection(
  projection: GraphRolePromptProjection,
): string {
  return `# ${projection.heading} (authoritative)\n\n${projection.body}`;
}

export interface ComposeGraphRolePromptInput {
  execution: GraphWorkflowExecution;
  prompt: string;
  executionContract?: GraphExecutionContract;
  role?: "implementer" | "context-validator";
  contextId?: string;
}

function downstreamContextIds(
  execution: GraphWorkflowExecution,
  contextId: string,
): Set<string> {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of execution.workingDefinition.edges) {
    const targets = targetsBySource.get(edge.sourceContextId) ?? [];
    targets.push(edge.targetContextId);
    targetsBySource.set(edge.sourceContextId, targets);
  }

  const downstream = new Set<string>();
  const pending = [...(targetsBySource.get(contextId) ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next === contextId || downstream.has(next)) continue;
    downstream.add(next);
    pending.push(...(targetsBySource.get(next) ?? []));
  }
  return downstream;
}

/**
 * The cohort derives from the working definition alone, so it renders for every
 * context validation. Only its first paragraph is projection-conditional: it
 * cites the Spec ownership section, which exists solely under a spec claims
 * projection, and a plain run must not carry a reference to a section it was
 * never given.
 */
function renderValidatorDeferralCohort(
  execution: GraphWorkflowExecution,
  contextId: string,
  hasPromptProjection: boolean,
): string {
  const authoredContexts = execution.workingDefinition.executionContexts;
  if (!authoredContexts.some((context) => context.id === contextId)) {
    throw new Error(
      `Cannot compose validator deferral cohort for missing context ${contextId}`,
    );
  }
  const downstream = downstreamContextIds(execution, contextId);
  const contexts = authoredContexts.filter(
    (context) => context.id === contextId || downstream.has(context.id),
  );

  return [
    "## Acceptance-criteria cohort for deferral checks",
    ...(hasPromptProjection
      ? [
          "The authoritative Spec ownership section above decides criterion assignment. Do not fail this context for criterion work assigned only to another claimant. A stable authored claimant may be a dynamic orchestrator accountable for generated or loop work; honor that ownership without tracing generated children or loop instances.",
          "",
        ]
      : []),
    "Ownership alone never authorizes a production-capability deferral. Missing production wiring may be deferred only to a graph-downstream owner, and only when either the current context's acceptance criteria explicitly name that downstream owner for the obligation, or the downstream owner's acceptance criteria below contain the matching obligation. A claim, context title, graph edge, or vague downstream reference is not enough. If neither route is present, raise an issue for the missing production call path.",
    "",
    "This is the current and graph-downstream authored acceptance-criteria cohort, not a wiring table. Upstream or unrelated claimants remain ownership-visible but cannot authorize a future production handoff:",
    "",
    ...contexts.flatMap((context) => [
      `### \`${context.id}\` — ${context.title}${context.id === contextId ? " (current context)" : ""}`,
      context.acceptanceCriteria,
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
}

/** The single composer used by implementer and context-validator prompts. */
export async function composeGraphRolePrompt(
  input: ComposeGraphRolePromptInput,
): Promise<string> {
  const contract =
    input.executionContract ?? createRegisteredGraphExecutionContract();
  const projection =
    (await contract.loadPromptProjection?.(input.execution)) ?? null;
  const projected =
    projection === null ? null : renderGraphRolePromptProjection(projection);

  if (input.role !== "context-validator") {
    return projected === null ? input.prompt : `${projected}\n\n${input.prompt}`;
  }
  if (input.contextId === undefined) {
    throw new Error(
      "A context-validator prompt requires its current context id",
    );
  }

  const cohort = renderValidatorDeferralCohort(
    input.execution,
    input.contextId,
    projected !== null,
  );
  return projected === null
    ? `${cohort}\n\n${input.prompt}`
    : `${projected}\n\n${cohort}\n\n${input.prompt}`;
}
