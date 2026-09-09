import { toAuthoredAssignment } from "@/lib/workflow-graph/authored-assignment";
import { lintOutputSchemaText } from "@/components/workflow-config/OutputSchemaField";
import type { ConfigPath } from "@/components/workflow-config-panel/config-cascade";
import type { ConfigTier } from "@/components/workflow-config-panel/types";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import type {
  CollaborationConfigSource,
  ResolvedCollaborationConfig,
  WorkflowCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  DEFAULT_AGENT_VALIDATION_CONFIG,
  type GraphWorkflowAgentValidationConfig,
} from "@/lib/workflow-graph/config-schemas";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  ResolvedAgentValidationConfig,
} from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";

/**
 * The live execution's configuration, in the shape the config panel edits.
 *
 * A running execution reads a SNAPSHOTTED resolved context: every cascade block
 * already carries a concrete value and there is no tier above it to inherit
 * from (doc 06, D1). The panel is written against an AUTHORED context, so the
 * draft is exactly that authored shape with every block populated from the
 * snapshot. Nothing is inferred: the value the run holds is the value the panel
 * shows, and provenance is proven from what the seed recorded rather than
 * guessed by comparing against today's global defaults.
 */

export interface LiveContextDraft {
  context: GraphWorkflowExecutionContextDefinition;
  /**
   * The output schema as RAW TEXT, never a parsed document: a half-typed
   * declaration has to survive a re-render and an SSE rebase, and the last valid
   * parse must not be what a save persists under fresh red text.
   */
  outputSchemaText: string;
}

/**
 * Where a live value came from, for the paths whose seed recorded it. A path
 * absent from the map has no recorded provenance and is shown as the context's
 * own — never as an inherited tier a value comparison merely suggests.
 */
export type LiveConfigProvenance = Partial<Record<ConfigPath, ConfigTier>>;

/** "per-node" is the stored spelling of the tier an operator calls Context. */
function tierOf(source: CollaborationConfigSource): ConfigTier {
  return source === "per-node" ? "context" : source;
}

/**
 * The one serialization of a stored schema document into editor text.
 *
 * Both the seed and the post-submit baseline go through here: the server keeps a
 * PARSED document, so any text whose formatting differs from this function's
 * output would re-seed as a permanent diff against itself.
 */
export function serializeOutputSchemaText(
  schema: Record<string, unknown> | null | undefined,
): string {
  return schema ? JSON.stringify(schema, null, 2) : "";
}

/**
 * A run seeded before the collaboration snapshot existed records nothing, and
 * policy enforcement treats that absence as the seeded defaults — so the panel
 * displays those, labelled `global`, which is exactly what the absence proves.
 */
function flatCollaborationOf(
  resolved: ResolvedCollaborationConfig | undefined,
): WorkflowCollaborationConfig {
  if (!resolved) return structuredClone(SEEDED_WORKFLOW_DEFAULTS.collaboration);
  return {
    enabled: resolved.enabled.value,
    secondAgent: resolved.secondAgent.value,
    negotiationRounds: resolved.negotiationRounds.value,
    autonomousResolutionThreshold: resolved.autonomousResolutionThreshold.value,
  };
}

/** Same absence rule as collaboration, for the per-role validation allowlists. */
function flatAgentValidationOf(
  resolved: ResolvedAgentValidationConfig | undefined,
): GraphWorkflowAgentValidationConfig {
  if (!resolved) return structuredClone(DEFAULT_AGENT_VALIDATION_CONFIG);
  return {
    implementer: resolved.implementer.value,
    contextValidator: resolved.contextValidator.value,
  };
}

export function toLiveDraft(
  context: GraphWorkflowResolvedContext,
): LiveContextDraft {
  return {
    context: {
      id: context.id,
      title: context.title,
      ...(context.description === undefined
        ? {}
        : { description: context.description }),
      // Records, always: the panel's ordered editor is record-shaped, and a
      // stored prose value canonicalizes through the schema module's own
      // normalizer exactly the way the accept paths would.
      acceptanceCriteria: criterionRecordsOf(context.acceptanceCriteria),
      placement: context.placement,
      ...(context.outputSchema === undefined
        ? {}
        : { outputSchema: context.outputSchema }),
      ...(context.routing === undefined ? {} : { routing: context.routing }),
      ...(context.origin === undefined ? {} : { origin: context.origin }),
      implementer: toAuthoredAssignment(context.implementer),
      contextValidator: {
        ...context.contextValidator,
        assignments:
          context.contextValidator.assignments.map(toAuthoredAssignment),
      },
      scriptValidator: context.scriptValidator,
      humanApprovalGate: context.humanApprovalGate,
      askUserQuestions: context.askUserQuestions,
      mutability: context.mutability,
      circuitBreaker: context.circuitBreaker,
      iterationPolicy: context.iterationPolicy,
      planRepair: context.planRepair,
      collaboration: flatCollaborationOf(context.collaboration),
      agentValidation: flatAgentValidationOf(context.agentValidation),
    },
    outputSchemaText: serializeOutputSchemaText(context.outputSchema),
  };
}

export function liveConfigProvenance(
  context: GraphWorkflowResolvedContext,
): LiveConfigProvenance {
  const collaboration = context.collaboration;
  const agentValidation = context.agentValidation;
  return {
    scriptValidator: tierOf(context.scriptValidatorSource ?? "global"),
    "collaboration.enabled": tierOf(collaboration?.enabled.source ?? "global"),
    "collaboration.secondAgent": tierOf(
      collaboration?.secondAgent.source ?? "global",
    ),
    "collaboration.negotiationRounds": tierOf(
      collaboration?.negotiationRounds.source ?? "global",
    ),
    "collaboration.autonomousResolutionThreshold": tierOf(
      collaboration?.autonomousResolutionThreshold.source ?? "global",
    ),
    "agentValidation.implementer": tierOf(
      agentValidation?.implementer.source ?? "global",
    ),
    "agentValidation.contextValidator": tierOf(
      agentValidation?.contextValidator.source ?? "global",
    ),
  };
}

type UpdateContextOp = Extract<
  WorkflowLiveEditOperation,
  { type: "update-context" }
>;

/**
 * The per-field and per-role provenance an edit writes back.
 *
 * The live op takes the WHOLE resolved block, so a one-field edit still has to
 * restate its siblings — and restating them as `per-node` would silently promote
 * the entire block, which is precisely what the cascade's field and role
 * granularities exist to prevent. Only what actually moved is attributed to the
 * context; everything else echoes the tier the seed recorded.
 */
function provenancedCollaboration(
  draft: WorkflowCollaborationConfig,
  base: WorkflowCollaborationConfig,
  stored: ResolvedCollaborationConfig | undefined,
): ResolvedCollaborationConfig {
  function field<K extends keyof WorkflowCollaborationConfig>(
    key: K,
  ): {
    value: WorkflowCollaborationConfig[K];
    source: CollaborationConfigSource;
  } {
    if (!deepEqualJson(draft[key], base[key])) {
      return { value: draft[key], source: "per-node" };
    }
    return { value: draft[key], source: stored?.[key].source ?? "global" };
  }
  return {
    enabled: field("enabled"),
    secondAgent: field("secondAgent"),
    negotiationRounds: field("negotiationRounds"),
    autonomousResolutionThreshold: field("autonomousResolutionThreshold"),
  };
}

function provenancedAgentValidation(
  draft: GraphWorkflowAgentValidationConfig,
  base: GraphWorkflowAgentValidationConfig,
  stored: ResolvedAgentValidationConfig | undefined,
): ResolvedAgentValidationConfig {
  function role(
    name: "implementer" | "contextValidator",
  ): ResolvedAgentValidationConfig["implementer"] {
    if (!deepEqualJson(draft[name], base[name])) {
      return { value: draft[name], source: "per-node" };
    }
    // The stored leaf carries its frozen `commands` snapshot alongside its
    // source, so echoing it whole is what keeps an untouched role byte-identical.
    return stored?.[name] ?? { value: draft[name], source: "global" };
  }
  return {
    implementer: role("implementer"),
    contextValidator: role("contextValidator"),
  };
}

/**
 * Diff the draft against the baseline it was seeded from and compose one
 * `update-context` op carrying ONLY what changed, or null when nothing did (the
 * op requires at least one field).
 *
 * Every block rides whole. That is what preserves the fields no screen exposes —
 * `mutability.allowAgentContextAdd` is the worked example — because the draft
 * holds them verbatim from the snapshot and hands them straight back.
 */
export function diffLiveContextOp({
  contextId,
  draft,
  base,
  stored,
}: {
  contextId: string;
  draft: LiveContextDraft;
  base: LiveContextDraft;
  stored: GraphWorkflowResolvedContext;
}): UpdateContextOp | null {
  const next = draft.context;
  const previous = base.context;
  const changes: Omit<UpdateContextOp, "type" | "contextId"> = {};

  if (next.title !== previous.title) changes.title = next.title;
  if (next.description !== previous.description) {
    changes.description =
      next.description === undefined || next.description.trim().length === 0
        ? null
        : next.description;
  }
  if (!deepEqualJson(next.acceptanceCriteria, previous.acceptanceCriteria)) {
    changes.acceptanceCriteria = next.acceptanceCriteria;
  }
  // The only text→document conversion in the tier. Dirtiness is a plain string
  // compare, so reformatting alone still re-persists an equivalent document —
  // but unparseable or unsupported text yields no field at all, and the save
  // bar's validity gate is what stops such a draft from saving everything
  // EXCEPT the schema the author is looking at.
  if (draft.outputSchemaText !== base.outputSchemaText) {
    const lint = lintOutputSchemaText(draft.outputSchemaText);
    if (lint.schema !== null) changes.outputSchema = lint.schema;
    else if (lint.stage === "empty") changes.outputSchema = null;
  }
  // Wholesale, like the schema: the grade discriminates on `mode`, so a partial
  // merge has no meaning.
  if (!deepEqualJson(next.placement, previous.placement)) {
    changes.placement = next.placement;
  }
  if (
    next.implementer &&
    !deepEqualJson(next.implementer, previous.implementer)
  ) {
    changes.implementer = next.implementer;
  }
  if (
    next.contextValidator &&
    !deepEqualJson(next.contextValidator, previous.contextValidator)
  ) {
    changes.contextValidator = next.contextValidator;
  }
  if (
    next.scriptValidator &&
    !deepEqualJson(next.scriptValidator, previous.scriptValidator)
  ) {
    changes.scriptValidator = next.scriptValidator;
  }
  if (
    next.humanApprovalGate &&
    !deepEqualJson(next.humanApprovalGate, previous.humanApprovalGate)
  ) {
    changes.humanApprovalGate = next.humanApprovalGate;
  }
  if (
    next.askUserQuestions &&
    !deepEqualJson(next.askUserQuestions, previous.askUserQuestions)
  ) {
    changes.askUserQuestions = next.askUserQuestions;
  }
  if (next.mutability && !deepEqualJson(next.mutability, previous.mutability)) {
    changes.mutability = next.mutability;
  }
  if (
    next.iterationPolicy &&
    !deepEqualJson(next.iterationPolicy, previous.iterationPolicy)
  ) {
    changes.iterationPolicy = next.iterationPolicy;
  }
  if (
    next.circuitBreaker &&
    !deepEqualJson(next.circuitBreaker, previous.circuitBreaker)
  ) {
    changes.circuitBreaker = next.circuitBreaker;
  }
  if (next.planRepair && !deepEqualJson(next.planRepair, previous.planRepair)) {
    changes.planRepair = next.planRepair;
  }
  if (!deepEqualJson(next.collaboration, previous.collaboration)) {
    // The authored shape holds the block as a partial override, so each side is
    // completed from the snapshot before the per-field verdict is taken — a
    // field the draft happens not to carry must not read as "changed to
    // nothing".
    const seeded = flatCollaborationOf(stored.collaboration);
    changes.collaboration = provenancedCollaboration(
      { ...seeded, ...next.collaboration },
      { ...seeded, ...previous.collaboration },
      stored.collaboration,
    );
  }
  if (!deepEqualJson(next.agentValidation, previous.agentValidation)) {
    const seeded = flatAgentValidationOf(stored.agentValidation);
    changes.agentValidation = provenancedAgentValidation(
      { ...seeded, ...next.agentValidation },
      { ...seeded, ...previous.agentValidation },
      stored.agentValidation,
    );
  }

  if (Object.keys(changes).length === 0) return null;
  return { type: "update-context", contextId, ...changes };
}

/**
 * Three-way merge of one field: if the user changed it from the baseline, keep
 * their value; otherwise adopt the incoming one.
 */
function threeWay<T>(ours: T, base: T, theirs: T): T {
  return deepEqualJson(ours, base) ? theirs : ours;
}

/**
 * The same three-way rule applied one key at a time, for a block whose leaves
 * are independently overridable. The key set comes from the fresh base, which
 * is the shape the server currently holds.
 */
function mergeLeaves<T extends Record<string, unknown>>(
  ours: T | undefined,
  base: T | undefined,
  theirs: T | undefined,
): T | undefined {
  // An absent block has no leaves to merge, so it falls back to the whole-value
  // rule — there is nothing finer to say about presence itself.
  if (ours === undefined || base === undefined || theirs === undefined) {
    return threeWay(ours, base, theirs);
  }
  const merged = { ...theirs };
  for (const key of Object.keys(theirs) as (keyof T)[]) {
    merged[key] = threeWay(ours[key], base[key], theirs[key]);
  }
  return merged;
}

/**
 * Rebase a stale draft onto a freshly-refetched baseline, preserving ONLY the
 * fields the user actually edited. Fields they never touched adopt the fresh
 * value, so a concurrent edit to an untouched field is neither displayed stale
 * nor echoed back into the retry payload (no lost update).
 *
 * The merge is per FIELD of the context rather than over the context as a
 * whole: a whole-object three-way would discard every concurrent change the
 * moment the author had touched anything at all.
 */
export function rebaseLiveDraft(
  draft: LiveContextDraft,
  seedBase: LiveContextDraft,
  freshBase: LiveContextDraft,
): LiveContextDraft {
  const ours = draft.context;
  const was = seedBase.context;
  const theirs = freshBase.context;
  function merge<K extends keyof GraphWorkflowExecutionContextDefinition>(
    key: K,
  ): GraphWorkflowExecutionContextDefinition[K] {
    return threeWay(ours[key], was[key], theirs[key]);
  }
  const description = merge("description");
  const collaboration = mergeLeaves(
    ours.collaboration,
    was.collaboration,
    theirs.collaboration,
  );
  const agentValidation = mergeLeaves(
    ours.agentValidation,
    was.agentValidation,
    theirs.agentValidation,
  );
  const outputSchema = merge("outputSchema");
  const routing = merge("routing");
  const origin = merge("origin");
  return {
    context: {
      // Identity, not content: the panel is keyed by context id, so a rebase
      // that could change it would be rebasing onto a different context.
      id: theirs.id,
      title: merge("title"),
      ...(description === undefined ? {} : { description }),
      acceptanceCriteria: merge("acceptanceCriteria"),
      placement: merge("placement"),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(routing === undefined ? {} : { routing }),
      ...(origin === undefined ? {} : { origin }),
      implementer: merge("implementer"),
      contextValidator: merge("contextValidator"),
      scriptValidator: merge("scriptValidator"),
      humanApprovalGate: merge("humanApprovalGate"),
      askUserQuestions: merge("askUserQuestions"),
      mutability: merge("mutability"),
      circuitBreaker: merge("circuitBreaker"),
      iterationPolicy: merge("iterationPolicy"),
      planRepair: merge("planRepair"),
      // These two rebase per LEAF, not per block, because that is the
      // granularity they cascade and diff at (README §7): collaboration is four
      // independent fields and agent validation is two independent roles.
      // Merging either wholesale keeps OUR stale siblings whenever any one leaf
      // is edited — and the diff then restates those siblings as per-node,
      // overwriting a concurrent change and promoting a leaf the author never
      // touched.
      ...(collaboration === undefined ? {} : { collaboration }),
      ...(agentValidation === undefined ? {} : { agentValidation }),
    },
    outputSchemaText: threeWay(
      draft.outputSchemaText,
      seedBase.outputSchemaText,
      freshBase.outputSchemaText,
    ),
  };
}
