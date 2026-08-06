/**
 * The agent-profile library: the single owner of combined listing, qualified
 * resolution, authoring, and deletion impact (D15).
 *
 * Consumers — the conversation service, API routes, the CLI, and later the
 * workflow compiler — call `list`, `read`, and `resolve` and never reach into
 * storage or the built-in constants themselves. That is what keeps four rules
 * in one place:
 *
 *   - **Tiers are siblings, not a shadowing chain.** A profile is addressed
 *     only as `{tier, id}`, so `builtin:general-reviewer` and
 *     `project:general-reviewer` are different profiles that both appear in a
 *     listing with tier provenance and resolve independently.
 *   - **Resolution fails closed.** An unknown, deleted, or quarantined
 *     reference raises `AgentProfileNotResolvableError` naming the qualified
 *     reference. It never falls back to a similarly named profile in another
 *     tier: a silent fallback would run an agent under instructions nobody
 *     chose.
 *   - **Identity is immutable after create.** Ids default to a slug of the
 *     name and are editable until create; afterwards `AgentProfileContent`
 *     has no `id` field for an update to carry.
 *   - **The builtin tier is read-only.** Every mutation entry point calls
 *     `assertMutableProfileTier` rather than re-deriving "is this a builtin".
 */

import { createLogger } from "@/lib/logging";

import { BUILTIN_AGENT_PROFILES, findBuiltinAgentProfile } from "./builtins";
import {
  AgentProfileInstructionCollisionError,
  findReservedSequence,
} from "./composer";
import { computeContentHash } from "./hashing";
import {
  agentProfileContentSchema,
  assertMutableProfileTier,
  assertValidAgentProfileId,
  deriveAgentProfileId,
  formatAgentProfileRef,
  isMutableProfileTier,
  type AgentProfile,
  type AgentProfileContentInput,
  type AgentProfileDeletionReport,
  type AgentProfileLibraryDiagnostic,
  type AgentProfileLibraryEntry,
  type AgentProfileLibraryItem,
  type AgentProfileLibraryListing,
  type AgentProfileRef,
  type AgentProfileSavedReferences,
  type AgentProfileTier,
  type ContentHash,
  type ResolvedAgentProfile,
  type StoredAgentProfileRecord,
} from "./schemas";
import {
  createAgentProfileStorage,
  scopeForMutableTier,
  type AgentProfileStorage,
} from "./storage";

const logger = createLogger("agent-profile-library");

// ============================================================
// Typed refusals
// ============================================================

/**
 * A reference that does not resolve. Carries the qualified reference because
 * the point of failing closed is that the caller learns exactly which
 * reference is dangling — not that some other profile quietly answered for it.
 */
export class AgentProfileNotResolvableError extends Error {
  readonly code = "agent_profile_not_resolvable" as const;

  constructor(readonly ref: AgentProfileRef) {
    super(
      `Agent profile ${formatAgentProfileRef(ref)} could not be resolved. It does not exist, was deleted, or is quarantined — check the profile listing for a diagnostic.`,
    );
    this.name = "AgentProfileNotResolvableError";
  }
}

export class AgentProfileDeletionNotConfirmedError extends Error {
  readonly code = "agent_profile_deletion_not_confirmed" as const;

  constructor(readonly ref: AgentProfileRef) {
    super(
      `Deleting agent profile ${formatAgentProfileRef(ref)} requires explicit confirmation.`,
    );
    this.name = "AgentProfileDeletionNotConfirmedError";
  }
}

/**
 * No reference reporter was wired into this library. Refusing is the point:
 * the alternative — answering "nothing references this profile" from a
 * composition that never looked — is the exact lie the preview exists to
 * prevent, and it would be invisible to the human confirming the delete.
 */
export class AgentProfileReferenceReporterUnavailableError extends Error {
  readonly code = "agent_profile_reference_reporter_unavailable" as const;

  constructor(readonly ref: AgentProfileRef) {
    super(
      `Cannot enumerate references to agent profile ${formatAgentProfileRef(ref)}: this library was constructed without a reference reporter.`,
    );
    this.name = "AgentProfileReferenceReporterUnavailableError";
  }
}

// ============================================================
// Service
// ============================================================

/**
 * The project a library operation runs in, or `null` when there is none — the
 * global-scope API surface and the CLI outside a project both address the
 * library without one. A null scope reaches the tiers that exist outside any
 * project (builtin, global); the project tier is refused rather than resolved
 * against a stand-in path.
 */
export type AgentProfileProjectScope = string | null;

export interface AgentProfileCreateRequest extends AgentProfileContentInput {
  projectPath: AgentProfileProjectScope;
  tier: AgentProfileTier;
  /** Defaults to `deriveAgentProfileId(name)` when the author leaves it blank. */
  id?: string;
}

export interface AgentProfileUpdateRequest {
  projectPath: AgentProfileProjectScope;
  ref: AgentProfileRef;
  expectedRevision: number;
  /**
   * Replaces the record's content wholesale. Omitted advisory arrays take
   * their schema default of empty — an update is never a partial patch, so a
   * caller cannot half-write a record by forgetting a field.
   */
  content: AgentProfileContentInput;
}

export interface AgentProfileDeleteRequest {
  projectPath: AgentProfileProjectScope;
  ref: AgentProfileRef;
  expectedRevision: number;
  /** Must be true; an unconfirmed delete is refused without touching storage. */
  confirmed: boolean;
}

export interface AgentProfileDuplicateRequest {
  projectPath: AgentProfileProjectScope;
  source: AgentProfileRef;
  targetTier: AgentProfileTier;
  /** Defaults to the source id; a collision refuses rather than suffixing. */
  targetId?: string;
}

/**
 * The port through which the library learns who references a profile.
 *
 * The library owns WHEN the question is asked (preview open, and again at the
 * delete that writes the report) and the shape of the answer; it owns nothing
 * about where references live. Workflow definitions, templates, and
 * `workflowDefaults` are the workflow domain's storage, so the workflow domain
 * implements this and the route composition wires it in — which is what keeps
 * the arrow pointing one way: agent-profiles never imports workflow-graph.
 */
export interface AgentProfileReferenceReporter {
  enumerateSavedReferences(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileSavedReferences>;
}

export interface AgentProfileLibraryService {
  /** Every tier reachable from `projectPath`; without one, those outside a project. */
  list(
    projectPath: AgentProfileProjectScope,
  ): Promise<AgentProfileLibraryListing>;
  /** The full record behind a reference. Fails closed like `resolve`. */
  read(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileLibraryEntry>;
  /** The composer's input: identity, the current revision, and its hash. */
  resolve(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<ResolvedAgentProfile>;
  create(request: AgentProfileCreateRequest): Promise<AgentProfileLibraryEntry>;
  update(request: AgentProfileUpdateRequest): Promise<AgentProfileLibraryEntry>;
  /**
   * What deleting this profile would cost, computed WITHOUT deleting it. The
   * read-only sibling of `delete`: same report, same reporter, no mutation —
   * so the human confirming sees the holders before, not after.
   */
  previewDeletion(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileDeletionReport>;
  delete(
    request: AgentProfileDeleteRequest,
  ): Promise<AgentProfileDeletionReport>;
  duplicateToScope(
    request: AgentProfileDuplicateRequest,
  ): Promise<AgentProfileLibraryEntry>;
}

export interface AgentProfileLibraryDeps {
  storage?: AgentProfileStorage;
  /**
   * Absent by default. Every construction that can reach a delete or a preview
   * must supply one; the ones that only resolve references never touch it.
   */
  referenceReporter?: AgentProfileReferenceReporter;
}

/** A loaded profile plus the hash covering the instructions it carries. */
interface LoadedProfile {
  entry: AgentProfileLibraryEntry;
  sourceContentHash: ContentHash;
}

function toEntry(
  tier: AgentProfileTier,
  profile: AgentProfile,
): AgentProfileLibraryEntry {
  return { ...profile, tier, readOnly: !isMutableProfileTier(tier) };
}

/**
 * The listing projection of a full entry: identity, provenance, and the
 * advisory metadata a picker needs — never the instruction text. Exported so a
 * mutation surface can answer with the same redacted shape a listing does
 * instead of echoing back what it was just handed (R6.3).
 */
export function agentProfileLibraryItemOf(
  entry: AgentProfileLibraryEntry,
): AgentProfileLibraryItem {
  return toItem(entry);
}

function toItem(entry: AgentProfileLibraryEntry): AgentProfileLibraryItem {
  return {
    ref: { tier: entry.tier, id: entry.id },
    name: entry.name,
    description: entry.description,
    revision: entry.revision,
    recommendedFor: entry.recommendedFor,
    tags: entry.tags,
    readOnly: entry.readOnly,
  };
}

function profileOf(record: StoredAgentProfileRecord): AgentProfile {
  return {
    id: record.id,
    revision: record.revision,
    name: record.name,
    description: record.description,
    instructions: record.instructions,
    recommendedFor: record.recommendedFor,
    tags: record.tags,
  };
}

export function createAgentProfileLibraryService(
  deps: AgentProfileLibraryDeps = {},
): AgentProfileLibraryService {
  const storage = deps.storage ?? createAgentProfileStorage();

  /**
   * The profile behind a reference, or null. Never consults another tier, and
   * never returns a record under an identity that was not asked for: a
   * reference resolves to the profile it names or to nothing.
   */
  async function load(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<LoadedProfile | null> {
    const loaded = await loadFromTier(projectPath, ref);
    if (loaded === null) return null;

    // Storage binds a record to its storage key, so this should be
    // unreachable. It stays because resolution's fail-closed contract is the
    // service's to keep: if the substrate ever handed back a different record,
    // returning it would run an agent under instructions nobody selected.
    if (loaded.entry.id !== ref.id) {
      logger.warn("agent-profile-library.identity_mismatch", {
        tier: ref.tier,
        requestedId: ref.id,
        returnedId: loaded.entry.id,
      });
      return null;
    }
    return loaded;
  }

  async function loadFromTier(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<LoadedProfile | null> {
    if (ref.tier === "builtin") {
      const builtin = findBuiltinAgentProfile(ref.id);
      if (!builtin) return null;
      // Built-ins store no hash: they are validated constants, so the hash of
      // the instructions being returned IS their provenance.
      return {
        entry: toEntry("builtin", builtin),
        sourceContentHash: computeContentHash(builtin.instructions),
      };
    }

    const record = await storage.get(
      scopeForMutableTier(ref.tier, projectPath),
      ref.id,
    );
    if (record === null) return null;

    // The STORED hash, not a fresh one: `buildAgentProfileSnapshot` fails
    // closed when a record's hash stops covering its instructions, and
    // recomputing here would make that check vacuous for stored records.
    return {
      entry: toEntry(ref.tier, profileOf(record)),
      sourceContentHash: record.sourceContentHash,
    };
  }

  async function loadOrThrow(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<LoadedProfile> {
    const loaded = await load(projectPath, ref);
    if (loaded === null) {
      throw new AgentProfileNotResolvableError(ref);
    }
    return loaded;
  }

  async function read(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileLibraryEntry> {
    return (await loadOrThrow(projectPath, ref)).entry;
  }

  async function resolve(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<ResolvedAgentProfile> {
    const { entry, sourceContentHash } = await loadOrThrow(projectPath, ref);
    return {
      tier: entry.tier,
      id: entry.id,
      name: entry.name,
      revision: entry.revision,
      sourceContentHash,
      instructions: entry.instructions,
    };
  }

  async function list(
    projectPath: AgentProfileProjectScope,
  ): Promise<AgentProfileLibraryListing> {
    // Without a project in scope the project tier does not exist to be listed —
    // an empty listing is the truthful answer, not a refusal, because the
    // caller asked what is available where it stands.
    const [globalListing, projectListing] = await Promise.all([
      storage.list(scopeForMutableTier("global", projectPath)),
      projectPath === null
        ? Promise.resolve({ records: [], diagnostics: [] })
        : storage.list(scopeForMutableTier("project", projectPath)),
    ]);

    // Same-id records across tiers are listed distinctly on purpose: they are
    // different profiles, and the consumer chooses between them by tier.
    const profiles = [
      ...BUILTIN_AGENT_PROFILES.map((profile) =>
        toItem(toEntry("builtin", profile)),
      ),
      ...globalListing.records.map((record) =>
        toItem(toEntry("global", profileOf(record))),
      ),
      ...projectListing.records.map((record) =>
        toItem(toEntry("project", profileOf(record))),
      ),
    ];

    const diagnostics: AgentProfileLibraryDiagnostic[] = [
      ...globalListing.diagnostics.map((diagnostic) => ({
        tier: "global" as const,
        ...diagnostic,
      })),
      ...projectListing.diagnostics.map((diagnostic) => ({
        tier: "project" as const,
        ...diagnostic,
      })),
    ];

    logger.debug("agent-profile-library.list", {
      builtinCount: BUILTIN_AGENT_PROFILES.length,
      globalCount: globalListing.records.length,
      projectCount: projectListing.records.length,
      quarantinedCount: diagnostics.length,
    });

    return { profiles, diagnostics };
  }

  /**
   * Guard the composer's containment invariant at save. A profile whose text
   * could terminate its own block — or the Codex system-instruction fence the
   * block travels inside — is refused here, before it is ever stored, so no
   * stored record can fail to render later.
   */
  function assertRenderableInstructions(instructions: string): void {
    const collision = findReservedSequence(instructions);
    if (collision !== null) {
      throw new AgentProfileInstructionCollisionError(collision);
    }
  }

  async function create(
    request: AgentProfileCreateRequest,
  ): Promise<AgentProfileLibraryEntry> {
    const { projectPath, tier, id, ...rest } = request;
    const content = agentProfileContentSchema.parse(rest);

    // The id defaults to a slug of the name, and is validated either way: an
    // unnameable profile is refused rather than given an invented identity.
    const ref: AgentProfileRef = {
      tier,
      id: assertValidAgentProfileId(id ?? deriveAgentProfileId(content.name)),
    };
    assertMutableProfileTier(ref, "create");
    assertRenderableInstructions(content.instructions);

    const record = await storage.create(
      scopeForMutableTier(ref.tier, projectPath),
      { id: ref.id, ...content },
    );
    logger.info("agent-profile-library.created", {
      tier: ref.tier,
      profileId: record.id,
    });
    return toEntry(ref.tier, profileOf(record));
  }

  async function update(
    request: AgentProfileUpdateRequest,
  ): Promise<AgentProfileLibraryEntry> {
    const { projectPath, ref, expectedRevision } = request;
    assertMutableProfileTier(ref, "update");

    // Strict parse: `AgentProfileContent` has no `id`, so a caller that sends
    // one is refused instead of silently renaming the record.
    const content = agentProfileContentSchema.parse(request.content);
    assertRenderableInstructions(content.instructions);

    const record = await storage.update(
      scopeForMutableTier(ref.tier, projectPath),
      ref.id,
      expectedRevision,
      content,
    );
    logger.info("agent-profile-library.updated", {
      tier: ref.tier,
      profileId: record.id,
      revision: record.revision,
    });
    return toEntry(ref.tier, profileOf(record));
  }

  async function enumerateSavedReferences(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileSavedReferences> {
    if (deps.referenceReporter === undefined) {
      throw new AgentProfileReferenceReporterUnavailableError(ref);
    }
    return deps.referenceReporter.enumerateSavedReferences(projectPath, ref);
  }

  async function previewDeletion(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileDeletionReport> {
    // The same two refusals a delete would raise, raised here instead — a
    // preview the delete could not honour would be worse than no preview.
    assertMutableProfileTier(ref, "delete");
    const { entry } = await loadOrThrow(projectPath, ref);

    return {
      ref,
      deletedRevision: entry.revision,
      conversationSnapshotsExempt: true,
      savedReferenceEnumeration: await enumerateSavedReferences(
        projectPath,
        ref,
      ),
    };
  }

  async function remove(
    request: AgentProfileDeleteRequest,
  ): Promise<AgentProfileDeletionReport> {
    const { projectPath, ref, expectedRevision, confirmed } = request;
    assertMutableProfileTier(ref, "delete");

    if (!confirmed) {
      throw new AgentProfileDeletionNotConfirmedError(ref);
    }

    // Enumerated BEFORE the record is removed: a reporter failure then refuses
    // the whole delete, rather than leaving a committed deletion with no report
    // to answer with.
    const savedReferenceEnumeration = await enumerateSavedReferences(
      projectPath,
      ref,
    );

    await storage.delete(
      scopeForMutableTier(ref.tier, projectPath),
      ref.id,
      expectedRevision,
    );
    logger.info("agent-profile-library.deleted", {
      tier: ref.tier,
      profileId: ref.id,
      revision: expectedRevision,
      referencingDefinitions: savedReferenceEnumeration.definitions.length,
      referencingTemplates: savedReferenceEnumeration.templates.length,
      referencedByWorkflowDefaults: savedReferenceEnumeration.workflowDefaults,
    });

    return {
      ref,
      deletedRevision: expectedRevision,
      conversationSnapshotsExempt: true,
      savedReferenceEnumeration,
    };
  }

  async function duplicateToScope(
    request: AgentProfileDuplicateRequest,
  ): Promise<AgentProfileLibraryEntry> {
    const { projectPath, source, targetTier, targetId } = request;
    const targetRef: AgentProfileRef = {
      tier: targetTier,
      id: assertValidAgentProfileId(targetId ?? source.id),
    };

    // Check the target tier BEFORE reading the source, so duplicating into the
    // builtin tier refuses on the tier rule rather than on whatever the source
    // happens to be.
    assertMutableProfileTier(targetRef, "create");

    // Reading fails closed, so a dangling source never yields a copy. Content
    // is copied, not referenced: the copy is independent from this point on.
    const sourceEntry = await read(projectPath, source);

    return create({
      projectPath,
      tier: targetRef.tier,
      id: targetRef.id,
      name: sourceEntry.name,
      description: sourceEntry.description,
      instructions: sourceEntry.instructions,
      recommendedFor: [...sourceEntry.recommendedFor],
      tags: [...sourceEntry.tags],
    });
  }

  return {
    list,
    read,
    resolve,
    create,
    update,
    previewDeletion,
    delete: remove,
    duplicateToScope,
  };
}
