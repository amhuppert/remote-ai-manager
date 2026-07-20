import { getGlobalSingleton } from "@/lib/shared/global-singleton";

/**
 * Merge association: the policy that links a fresh user-initiated merge to the
 * spec execution whose work it would publish. Resolution happens once, at job
 * dispatch, so the association is a durable fact on the job record; callers
 * that already know their provenance (graph final-publish joins, land
 * re-entry, conflict retry carrying a prior job's stamps) never consult this
 * port. The registry lives behind a global singleton so the jobs domain stays
 * free of spec imports; the specs composition root registers the resolver.
 * Unregistered means every merge passes through unlinked — the pre-existing
 * "ships dark" behavior tests and non-spec deployments rely on.
 */
export interface MergeAssociationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  /** Requested merge target; undefined means the session's default target. */
  targetBranch?: string;
}

export type MergeAssociationResolution =
  | { kind: "none" }
  | { kind: "linked"; executionId: string; finalPublish: boolean }
  | { kind: "refused"; reason: string; instruction: string };

export interface MergeAssociationResolver {
  resolve(input: MergeAssociationInput): MergeAssociationResolution;
}

const MERGE_ASSOCIATION_PORT_KEY = "__cc_merge_association_port" as const;

interface MergeAssociationPortState {
  resolver: MergeAssociationResolver | null;
}

function state(): MergeAssociationPortState {
  return getGlobalSingleton(MERGE_ASSOCIATION_PORT_KEY, () => ({
    resolver: null,
  }));
}

export function registerMergeAssociationResolver(
  resolver: MergeAssociationResolver,
): void {
  state().resolver = resolver;
}

export function resolveRegisteredMergeAssociation(
  input: MergeAssociationInput,
): MergeAssociationResolution {
  const resolver = state().resolver;
  if (resolver === null) return { kind: "none" };
  return resolver.resolve(input);
}

export function _resetMergeAssociationResolverForTesting(): void {
  state().resolver = null;
}
