import type { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type {
  MemoryNotePatch,
  MemoryRepo,
  WriteMemoryNoteResult,
} from "@/lib/state-store/memory-repo";
import {
  assessMemoryHook,
  memoryOverlapQuery,
  type MemoryHookWarning,
} from "./advisories";
import type {
  MemoryContributionDecision,
  MemoryContributionGate,
  MemoryPolicyResolution,
} from "./delivery-policy";
import { publishMemoryChange } from "./events";
import {
  defaultMemoryReviewLeaseMs,
  isPromotableSessionNote,
  leasedUntil,
  refreshedMemoryLease,
} from "./freshness";
import {
  MEMORY_BODY_MAX_BYTES,
  MEMORY_MAX_ALIASES,
  MEMORY_STATE_NOTE_LEASE_MS,
  MEMORY_STATUS_NOTE_LEASE_MS,
  memoryBodyByteLength,
  createMemoryNoteRequestSchema,
  linkMemoryNoteRequestSchema,
  markMemoryReviewedRequestSchema,
  memoryActorSchema,
  memoryLifecycleActRequestSchema,
  memoryProposalDecisionRequestSchema,
  memoryNoteListRequestSchema,
  memoryNoteSchema,
  memoryResolveOptionsSchema,
  memorySessionEndInputSchema,
  promoteMemoryNoteRequestSchema,
  restoreMemoryNoteRequestSchema,
  unlinkMemoryNoteRequestSchema,
  updateMemoryNoteRequestSchema,
  type CreateMemoryNoteRequest,
  type LinkMemoryNoteRequest,
  type MarkMemoryReviewedRequest,
  type MemoryActor,
  type MemoryArtifactRef,
  type MemoryChangeKind,
  type MemoryLifecycle,
  type MemoryLifecycleActRequest,
  type MemoryProposalDecisionRequest,
  type MemoryLink,
  type MemoryNote,
  type MemoryNoteListRequest,
  type MemoryNoteRevision,
  MEMORY_RESOLVE_ANY_LIFECYCLE,
  type MemoryHandleNarrowing,
  type MemoryResolveOptions,
  type MemoryScope,
  type MemorySessionEndInput,
  type MemoryStatusNote,
  type MemoryVisibility,
  type PromoteMemoryNoteRequest,
  type RestoreMemoryNoteRequest,
  type UnlinkMemoryNoteRequest,
  type UpdateMemoryNoteRequest,
} from "./schemas";
import { deriveMemorySlug, suffixMemorySlug } from "./slugs";
import type { MemorySessionLifecycleReader } from "./session-lifecycle";

const logger = createLogger("memory.service");

/** How many overlap candidates a capture reports: enough to notice a duplicate, few enough to read. */
const MAX_OVERLAP_CANDIDATES = 5;

/**
 * Generated-slug collision retries before the write path gives up on ordinal
 * suffixes and appends the note's own id. Fifty same-hook captures in one scope
 * is not a workflow the ordinals need to make pretty.
 */
const MAX_SLUG_ORDINAL = 50;

// ============================================================
// Error vocabulary
// ============================================================

export interface MemoryValidationIssue {
  path: string;
  message: string;
}

/** One candidate of a bare-slug disambiguation, labeled by its scope owner. */
export interface MemoryHandleCandidate {
  memoryId: string;
  slug: string;
  scope: MemoryScope;
  projectPath: string | null;
  sessionName: string | null;
  sessionCreatedAt: string | null;
  lifecycle: MemoryLifecycle;
  hook: string;
}

/**
 * Every refusal names its subject and carries a server-authored rationale and
 * instruction, so the HTTP mapper, the CLI, and the Library render the same
 * explanation without re-deriving why the write was refused. The CLI adds the
 * exact recovery command on top; the fields it needs (the current revision,
 * the labeled candidates) are here.
 */
export type MemoryError =
  | {
      code: "validation_failed";
      message: string;
      rationale: string;
      instruction: string;
      issues: MemoryValidationIssue[];
    }
  | {
      code: "not_found";
      message: string;
      rationale: string;
      instruction: string;
      handle: string;
    }
  | {
      code: "ambiguous_handle";
      message: string;
      rationale: string;
      instruction: string;
      handle: string;
      candidates: MemoryHandleCandidate[];
    }
  | {
      code: "scope_unavailable";
      message: string;
      rationale: string;
      instruction: string;
      scope: MemoryScope;
      missing: "project" | "session";
    }
  | {
      code: "slug_taken";
      message: string;
      rationale: string;
      instruction: string;
      slug: string;
      scope: MemoryScope;
    }
  | {
      code: "stale_revision";
      message: string;
      rationale: string;
      instruction: string;
      currentRevision: number;
      baseRevision: number;
      /**
       * The resolved note's canonical slug. A surface composing the retry
       * command must name the note, and the handle the caller sent may be an
       * internal id or an alias — neither of which may appear in agent-facing
       * text (inv-slug-only-text-output).
       */
      slug: string;
    }
  | {
      code: "body_too_large";
      message: string;
      rationale: string;
      instruction: string;
      limitBytes: number;
      actualBytes: number;
    }
  | {
      code: "revision_not_found";
      message: string;
      rationale: string;
      instruction: string;
      revision: number;
    }
  | {
      code: "human_act_required";
      message: string;
      rationale: string;
      instruction: string;
      act: "approve-proposal" | "reject-proposal";
    }
  | {
      code: "not_proposed";
      message: string;
      rationale: string;
      instruction: string;
      lifecycle: MemoryLifecycle;
    }
  | {
      code: "link_not_found";
      message: string;
      rationale: string;
      instruction: string;
    }
  | {
      code: "no_status_note";
      message: string;
      rationale: string;
      instruction: string;
    }
  | {
      code: "policy_refused";
      message: string;
      rationale: string;
      instruction: string;
      verb: MemoryMutationVerb;
      reason: "contribution_off" | "caller_unresolved";
      /** The resolved policy the refusal names; null when the caller could not be placed. */
      policy: MemoryPolicyResolution | null;
    };

/** Every verb the contribution policy governs (R10): each names itself in its refusal. */
export type MemoryMutationVerb =
  | "create"
  | "update"
  | "link"
  | "unlink"
  | "archive"
  | "restore"
  | "delete"
  | "mark-reviewed"
  | "promote"
  | "approve-proposal"
  | "reject-proposal";

export type MemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryError };

function success<T>(value: T): MemoryResult<T> {
  return { ok: true, value };
}

function failure<T>(error: MemoryError): MemoryResult<T> {
  return { ok: false, error };
}

function validationFailed<T>(error: z.ZodError): MemoryResult<T> {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  return failure({
    code: "validation_failed",
    message: `The memory request is not valid: ${issues
      .map((issue) => `${issue.path || "<root>"} ${issue.message}`)
      .join("; ")}`,
    rationale: "The request did not satisfy the memory note contract.",
    instruction: "Correct the named fields and retry.",
    issues,
  });
}

/**
 * The typed refusal every mutation returns when the writer's contribution
 * policy is off (R10.1): it names the verb, the role, the value, and the tier
 * that set it, and says what stays available — the retrieval verbs are never
 * gated, so a refused writer can still read deliberately.
 */
function policyRefused<T>(
  verb: MemoryMutationVerb,
  decision: Exclude<MemoryContributionDecision, { allowed: true }>,
): MemoryResult<T> {
  const available =
    "Explicit retrieval stays available: cctl memory recall, get, list, and index.";
  if (decision.reason === "caller_unresolved") {
    return failure({
      code: "policy_refused",
      message: `${verb} refused: conversation ${decision.conversationId} is not one Command Center can place, so no memory contribution policy applies to it.`,
      rationale:
        "Memory writes are admitted by the writing conversation's role; a caller with no conversation has no role, and the roles the spec ships as off are exactly the ones that would otherwise pass as none.",
      instruction: `Run memory verbs from a conversation Command Center manages (CC_CONVERSATION_ID names one). ${available}`,
      verb,
      reason: decision.reason,
      policy: null,
    });
  }
  const { policy } = decision;
  return failure({
    code: "policy_refused",
    message: `${verb} refused: memory contribution is off for this ${policy.role} (contribute: off, set at the ${policy.contribute.source} tier; read: ${policy.read.value}).`,
    rationale:
      "Ambient memory and memory writes are role-conditioned so an independent role cannot be primed by, or prime, another lane's premise (memory D7).",
    instruction: `Change the ${policy.role} memory policy in the configuration cascade (global settings, the workflow definition, or this execution context) if this role should contribute. ${available}`,
    verb,
    reason: decision.reason,
    policy,
  });
}

/**
 * The shape internal memory ids are minted in — `randomUUID` in production,
 * and the same shape in every fixture.
 */
const MEMORY_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A caller-supplied handle rendered for agent-facing TEXT. Naming the handle
 * that failed is the whole value of a refusal, but an internal id must never
 * reach that text (inv-slug-only-text-output covers refusals) — and a handle
 * the caller took from a `--json` envelope IS one. An id-shaped handle is
 * therefore described rather than echoed, while a slug, the one handle an
 * agent is meant to see, is echoed unchanged.
 *
 * The identity is not lost: every refusal below carries the raw handle in its
 * structured detail, which only the `--json` envelope renders. The test is on
 * SHAPE rather than on whether a row exists, because an id that addresses
 * nothing is still an id the agent should not be taught to read back.
 */
function handleForText(handle: string): string {
  return MEMORY_ID_SHAPE.test(handle) ? "that id" : handle;
}

function notFound<T>(handle: string): MemoryResult<T> {
  return failure({
    code: "not_found",
    message: `No memory note answers to ${handleForText(handle)} in your visible scopes.`,
    rationale:
      "The handle matches no active note's slug, alias, or id among the global, project, and session notes you can see; an archived note needs the explicit archived filter.",
    instruction:
      "Run 'cctl memory list' to find the current slug, or 'cctl memory list --archived' if the note was archived.",
    handle,
  });
}

/** Candidates ordered broad-to-narrow so the label order is stable. */
const SCOPE_RANK: Record<MemoryScope, number> = {
  global: 0,
  project: 1,
  session: 2,
};

function toCandidate(note: MemoryNote): MemoryHandleCandidate {
  return {
    memoryId: note.id,
    slug: note.slug,
    scope: note.scope,
    projectPath: note.projectPath,
    sessionName: note.sessionName,
    sessionCreatedAt: note.sessionCreatedAt,
    lifecycle: note.lifecycle,
    hook: note.hook,
  };
}

function ambiguousHandle<T>(
  handle: string,
  notes: readonly MemoryNote[],
): MemoryResult<T> {
  const candidates = [...notes]
    .sort(
      (a, b) =>
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        a.updatedAt.localeCompare(b.updatedAt) ||
        a.id.localeCompare(b.id),
    )
    .map(toCandidate);
  return failure({
    code: "ambiguous_handle",
    message: `${handleForText(handle)} matches ${candidates.length} notes in different scopes: ${candidates
      .map((candidate) => `${candidate.scope} (${candidate.lifecycle})`)
      .join(", ")}.`,
    rationale:
      "Slugs are scope-local, so the same slug can exist at global, project, and session scope at once; picking one silently would resolve differently as your ambient scope changes.",
    instruction:
      "Repeat the command narrowed to one of the listed scopes, or address the note by its id.",
    handle,
    candidates,
  });
}

function scopeUnavailable<T>(
  scope: MemoryScope,
  missing: "project" | "session",
): MemoryResult<T> {
  return failure({
    code: "scope_unavailable",
    message: `A ${scope}-scoped note needs a ${missing}, and this conversation has none.`,
    rationale:
      "A note's scope owner is the writer's own project or session incarnation; a conversation cannot write into a scope it does not occupy.",
    instruction:
      missing === "session"
        ? "Capture at project or global scope, or write the session note from a session conversation."
        : "Capture at global scope, or write the note from a conversation inside the project.",
    scope,
    missing,
  });
}

function slugTaken<T>(slug: string, scope: MemoryScope): MemoryResult<T> {
  return failure({
    code: "slug_taken",
    message: `The slug ${slug} is already an active note's slug or alias at ${scope} scope.`,
    rationale:
      "Slugs and aliases are unique among the active notes of one scope owner, so a bare handle resolves to one note.",
    instruction:
      "Choose another slug, omit it to have one generated, or supersede the existing note if this replaces it.",
    slug,
    scope,
  });
}

/**
 * A promotion whose handle is already held in the project scope. The generic
 * slug refusal offers a generated slug; promotion never generates one, because
 * the whole point of the act is to carry a known handle up a scope (R10).
 */
function promotionHandleTaken<T>(handle: string): MemoryResult<T> {
  return failure({
    code: "slug_taken",
    message: `The handle ${handleForText(handle)} is already held by an active project note, so promoting onto it would shadow that note.`,
    rationale:
      "Slugs and aliases are unique among the active notes of one scope owner, and a promotion never suffixes or overwrites: the collision is the promoter's decision to make.",
    instruction: `Promote with an explicit different slug, or supersede ${handleForText(handle)} deliberately if this replaces it.`,
    slug: handle,
    scope: "project",
  });
}

/** Promotion is session→project by definition (R10): nothing else is promotable. */
function notPromotable<T>(reason: string): MemoryResult<T> {
  return failure({
    code: "validation_failed",
    message: `This note cannot be promoted: ${reason}`,
    rationale:
      "Promotion moves a session incarnation's durable knowledge up to its project by superseding it; a note that is not a durable session note has nothing to move.",
    instruction:
      "Promote a session-scoped lesson, procedure, or preference. Edit or supersede any other note directly.",
    issues: [{ path: "handle", message: reason }],
  });
}

function staleRevision<T>(
  currentRevision: number,
  baseRevision: number,
  slug: string,
): MemoryResult<T> {
  return failure({
    code: "stale_revision",
    message: `This write states revision ${baseRevision}, but the note is now at revision ${currentRevision}.`,
    rationale:
      "Another writer changed the note after the revision this write was based on; overwriting blind would discard their edit.",
    instruction: `Read ${slug} again and retry against revision ${currentRevision}.`,
    currentRevision,
    baseRevision,
    slug,
  });
}

function bodyTooLarge<T>(
  limitBytes: number,
  actualBytes: number,
): MemoryResult<T> {
  return failure({
    code: "body_too_large",
    message: `The body is ${actualBytes} bytes; the limit is ${limitBytes} bytes (8 KiB).`,
    rationale:
      "A note's body is bounded so one note cannot consume the delivery budget every conversation shares.",
    instruction:
      "Shorten the body, move the detail into a linked artifact, or split it into separate notes.",
    limitBytes,
    actualBytes,
  });
}

function revisionNotFound<T>(revision: number): MemoryResult<T> {
  return failure({
    code: "revision_not_found",
    message: `The note has no revision ${revision}.`,
    rationale:
      "Revisions are numbered from 1 up to the current head; the requested number is outside that history.",
    instruction: "List the note's revisions and restore one that exists.",
    revision,
  });
}

function humanActRequired<T>(
  act: "approve-proposal" | "reject-proposal",
): MemoryResult<T> {
  return failure({
    code: "human_act_required",
    message: `Only a human can ${act === "approve-proposal" ? "approve" : "reject"} a global proposal.`,
    rationale:
      "A global note primes every project's agents; the one approval boundary in the write path is a human's.",
    instruction:
      "Leave the proposal for review in the Memory Library, or capture the fact at project scope instead.",
    act,
  });
}

function notProposed<T>(lifecycle: MemoryLifecycle): MemoryResult<T> {
  return failure({
    code: "not_proposed",
    message: `The note is ${lifecycle}, not a pending proposal.`,
    rationale:
      "Approval and rejection are the two exits of the proposed lifecycle; a note that is already active or archived has nothing to decide.",
    instruction:
      "Archive or restore the note through the ordinary operations instead.",
    lifecycle,
  });
}

function noStatusNote<T>(): MemoryResult<T> {
  return failure({
    code: "no_status_note",
    message: "The note has no status line to mark reviewed.",
    rationale:
      "A status review refreshes the statusNote's own lease; without a status line there is nothing at that level to act on.",
    instruction:
      "Mark the note itself reviewed, or add a status line with an update first.",
  });
}

function linkNotFound<T>(): MemoryResult<T> {
  return failure({
    code: "link_not_found",
    message: "The note has no such link.",
    rationale:
      "A link is only ever reachable through the note it was created on, so an id or identity from another note resolves to nothing here.",
    instruction: "Read the note to see its current links.",
  });
}

// ============================================================
// Service contract
// ============================================================

export interface MemoryOverlapCandidate {
  memoryId: string;
  slug: string;
  scope: MemoryScope;
  hook: string;
  /** FTS5 bm25: negative, and more negative is a closer match. */
  score: number;
}

/** Advisory-only output beside a successful create (R9): never a refusal. */
export interface MemoryCaptureAdvisories {
  overlapCandidates: MemoryOverlapCandidate[];
  hookWarnings: MemoryHookWarning[];
}

export interface MemoryCaptureOutcome {
  note: MemoryNote;
  advisories: MemoryCaptureAdvisories;
}

/** A review act's result: the note with the reviewed level's lease refreshed. */
export interface MemoryReviewOutcome {
  note: MemoryNote;
  /**
   * The claim a status re-lease put back into ambient delivery (R2.2, D8):
   * its text, when it was WRITTEN, and the lease it now holds. Null for a
   * note-level review, so a surface can tell the two acts apart without
   * diffing revisions. Read off the written record, so it cannot disagree
   * with what the next index build carries.
   */
  statusReLease: MemoryStatusNote | null;
}

/**
 * What session completion did: the state notes it retired, and the durable
 * notes now offered for promotion. Both are the notes themselves rather than
 * counts, so the caller logs the counts and the Library renders the records
 * from one read.
 */
export interface MemorySessionEndOutcome {
  readonly archived: MemoryNote[];
  readonly promotionCandidates: MemoryNote[];
  /**
   * State notes archived for OTHER over incarnations of the same project —
   * completions whose own memory step never landed. Reported separately so a
   * log line distinguishes this completion's work from the backlog it healed.
   */
  readonly reconciled: MemoryNote[];
}

/** The promoted successor and the session note it retired, as both now stand. */
/**
 * A link act's answer: the row written or removed, and the note it belongs to.
 * The note travels because every surface that reports the act has to NAME the
 * subject, and the handle the caller sent may be an internal id or an alias —
 * neither of which may reach agent-facing text (inv-slug-only-text-output).
 */
export interface MemoryLinkOutcome {
  readonly link: MemoryLink;
  readonly note: MemoryNote;
}

export interface MemoryPromotionOutcome {
  readonly promoted: MemoryNote;
  readonly superseded: MemoryNote;
}

export interface MemoryServiceDeps {
  repo: MemoryRepo;
  publish: PublishFn;
  /**
   * The contribution policy gate (R10): consulted by every mutation verb before
   * any resolution or write, so a refused writer changes nothing and publishes
   * nothing. Retrieval verbs never consult it.
   */
  contributionGate: MemoryContributionGate;
  /** Session completion asks this whether an incarnation is over (R10). */
  sessions: MemorySessionLifecycleReader;
  now(): string;
  generateId(): string;
}

/**
 * The single owner of memory write decisions: scope authority, slug
 * collision-safety, compare-and-swap, the proposal boundary, and typed event
 * publication. Every surface (routes, CLI, Library, session-end hooks) reaches
 * the repository through this, so a refused write can never publish and an
 * accepted one can never go unannounced.
 */
export interface MemoryService {
  create(
    request: CreateMemoryNoteRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryCaptureOutcome>>;
  /** Slug, alias, or id → one visible note, or a labeled disambiguation (R4). */
  resolve(
    handle: string,
    actor: MemoryActor,
    options?: MemoryResolveOptions,
  ): Promise<MemoryResult<MemoryNote>>;
  get(
    handle: string,
    actor: MemoryActor,
    options?: MemoryResolveOptions,
  ): Promise<MemoryResult<{ note: MemoryNote; links: MemoryLink[] }>>;
  list(
    request: MemoryNoteListRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryNote[]>>;
  listRevisions(
    handle: string,
    actor: MemoryActor,
    limit?: number,
  ): Promise<MemoryResult<MemoryNoteRevision[]>>;
  update(
    handle: string,
    request: UpdateMemoryNoteRequest,
    actor: MemoryActor,
    narrowing?: MemoryHandleNarrowing,
  ): Promise<MemoryResult<MemoryNote>>;
  link(
    handle: string,
    request: LinkMemoryNoteRequest,
    actor: MemoryActor,
    narrowing?: MemoryHandleNarrowing,
  ): Promise<MemoryResult<MemoryLinkOutcome>>;
  unlink(
    handle: string,
    request: UnlinkMemoryNoteRequest,
    actor: MemoryActor,
    narrowing?: MemoryHandleNarrowing,
  ): Promise<MemoryResult<MemoryLinkOutcome>>;
  /** The ordinary, reversible removal (R9). */
  archive(
    handle: string,
    request: MemoryLifecycleActRequest,
    actor: MemoryActor,
    narrowing?: MemoryHandleNarrowing,
  ): Promise<MemoryResult<MemoryNote>>;
  restore(
    handle: string,
    request: RestoreMemoryNoteRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryNote>>;
  /**
   * Permanent. The separate confirmation the spec requires is a surface act
   * (a CLI flag, a Library dialog); the service performs what was confirmed.
   */
  delete(
    handle: string,
    actor: MemoryActor,
    narrowing?: MemoryHandleNarrowing,
  ): Promise<MemoryResult<MemoryNote>>;
  /**
   * The review act (R2): `note` refreshes the note's own lease; `statusNote`
   * refreshes the status line's lease. Each restores the corresponding
   * ambient delivery.
   */
  markReviewed(
    handle: string,
    request: MarkMemoryReviewedRequest,
    actor: MemoryActor,
    narrowing?: MemoryHandleNarrowing,
  ): Promise<MemoryResult<MemoryReviewOutcome>>;
  /**
   * Human acts: the two exits of a global proposal (R9). Each states the
   * proposed revision the human reviewed; a decision about a revision that is
   * no longer the head is refused as stale before anything is written.
   */
  approveProposal(
    handle: string,
    request: MemoryProposalDecisionRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryNote>>;
  rejectProposal(
    handle: string,
    request: MemoryProposalDecisionRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryNote>>;
  /**
   * Session completion (R10): the session's wholly perishable state notes
   * archive, and its durable notes become promotion candidates. Server-
   * initiated, so it takes no actor — the session's own lifecycle is the
   * authority, and the archives compete with no author's revision.
   */
  finishSession(
    input: MemorySessionEndInput,
  ): Promise<MemoryResult<MemorySessionEndOutcome>>;
  /**
   * Promotion (R10): one act creating the project-scope successor of a session
   * note, optionally rewriting it on the way. A handle collision in the project
   * scope is refused naming the holder — never suffixed, never overwritten.
   */
  promote(
    handle: string,
    request: PromoteMemoryNoteRequest,
    actor: MemoryActor,
  ): Promise<MemoryResult<MemoryPromotionOutcome>>;
  /**
   * Archive the state notes of EVERY over session incarnation, in every
   * project (R10). The durable recovery trigger behind completion-time
   * archival: a completion that failed after its retries leaves the work
   * recorded in the store itself — an active state note whose incarnation is
   * over — so this sweep finds and finishes it without depending on another
   * session ever completing. Idempotent; safe to run on every startup.
   */
  reconcileSessionMemory(): Promise<
    MemoryResult<{ readonly archived: MemoryNote[] }>
  >;
}

// ============================================================
// Scope authority
// ============================================================

interface ScopeOwner {
  readonly scope: MemoryScope;
  readonly projectPath: string | null;
  readonly sessionName: string | null;
  readonly sessionCreatedAt: string | null;
}

/**
 * The scope owner a request binds to, taken from the actor's own visibility.
 * This is the whole authority check: the owner is never a request field, so a
 * conversation can only write where it stands.
 */
function ownerFor(
  scope: MemoryScope,
  visibility: MemoryVisibility,
):
  | { ok: true; owner: ScopeOwner }
  | { ok: false; missing: "project" | "session" } {
  if (scope === "global") {
    return {
      ok: true,
      owner: {
        scope,
        projectPath: null,
        sessionName: null,
        sessionCreatedAt: null,
      },
    };
  }
  if (visibility.projectPath === null) return { ok: false, missing: "project" };
  if (scope === "project") {
    return {
      ok: true,
      owner: {
        scope,
        projectPath: visibility.projectPath,
        sessionName: null,
        sessionCreatedAt: null,
      },
    };
  }
  if (visibility.session === null) return { ok: false, missing: "session" };
  return {
    ok: true,
    owner: {
      scope,
      projectPath: visibility.projectPath,
      sessionName: visibility.session.sessionName,
      sessionCreatedAt: visibility.session.sessionCreatedAt,
    },
  };
}

function ownerOf(note: MemoryNote): ScopeOwner {
  return {
    scope: note.scope,
    projectPath: note.projectPath,
    sessionName: note.sessionName,
    sessionCreatedAt: note.sessionCreatedAt,
  };
}

/** The visibility that sees exactly one scope owner's notes. */
function ownerVisibility(owner: ScopeOwner): MemoryVisibility {
  return {
    projectPath: owner.projectPath,
    session:
      owner.sessionName !== null && owner.sessionCreatedAt !== null
        ? {
            sessionName: owner.sessionName,
            sessionCreatedAt: owner.sessionCreatedAt,
          }
        : null,
  };
}

/** R3: global always; project by path; session by exact incarnation. */
function isVisible(note: MemoryNote, visibility: MemoryVisibility): boolean {
  switch (note.scope) {
    case "global":
      return true;
    case "project":
      return note.projectPath === visibility.projectPath;
    case "session":
      return (
        note.projectPath === visibility.projectPath &&
        visibility.session !== null &&
        note.sessionName === visibility.session.sessionName &&
        note.sessionCreatedAt === visibility.session.sessionCreatedAt
      );
  }
}

function sameArtifact(a: MemoryArtifactRef, b: MemoryArtifactRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "ticket":
      return b.kind === "ticket" && a.ticketId === b.ticketId;
    case "spec":
      return b.kind === "spec" && a.specId === b.specId;
    case "workflow_execution":
      return b.kind === "workflow_execution" && a.executionId === b.executionId;
    case "workflow_context":
      return (
        b.kind === "workflow_context" &&
        a.executionId === b.executionId &&
        a.contextId === b.contextId
      );
    case "session":
      return (
        b.kind === "session" &&
        a.projectPath === b.projectPath &&
        a.sessionName === b.sessionName &&
        a.sessionCreatedAt === b.sessionCreatedAt
      );
  }
}

function leasedStatusNote(text: string, writtenAt: string): MemoryStatusNote {
  return {
    text,
    updatedAt: writtenAt,
    reviewAfter: leasedUntil(writtenAt, MEMORY_STATUS_NOTE_LEASE_MS),
  };
}

/**
 * The note-level lease a capture opens with (R2): a state note is wholly
 * perishable and leases short by default; durable kinds lease out only when
 * the writer says so.
 */
function openingReviewLease(
  requested: string | null,
  kind: MemoryNote["kind"],
  createdAt: string,
): string | null {
  if (requested !== null) return requested;
  return kind === "state"
    ? leasedUntil(createdAt, MEMORY_STATE_NOTE_LEASE_MS)
    : null;
}

function authorFields(actor: MemoryActor): {
  authorKind: MemoryActor["kind"];
  authorConversationId: string | null;
} {
  return {
    authorKind: actor.kind,
    authorConversationId: actor.kind === "agent" ? actor.conversationId : null,
  };
}

/**
 * The author session completion records. Nobody asked for these archives — the
 * session ending did — and the store's author kinds are `user` and `agent`
 * only. `user` is the honest half of that pair: attributing housekeeping to
 * whichever agent last ran in the session would name an author who did not act.
 */
const SESSION_END_ACTOR: MemoryActor = {
  kind: "user",
  visibility: { projectPath: null, session: null },
};

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  function publishChange(
    change: MemoryChangeKind,
    note: MemoryNote,
    actor: MemoryActor,
    link: { id: string; kind: MemoryLink["kind"] } | null = null,
  ): void {
    publishMemoryChange({
      publish: deps.publish,
      logger,
      change,
      note,
      authorKind: actor.kind,
      link,
    });
  }

  /** The typed refusal when the writer may not contribute, or null when it may. */
  async function refuseIfContributionOff<T>(
    verb: MemoryMutationVerb,
    actor: MemoryActor,
  ): Promise<MemoryResult<T> | null> {
    const decision = await deps.contributionGate.decide(actor);
    if (decision.allowed) return null;
    logger.info("memory.service.policy_refused", {
      verb,
      reason: decision.reason,
      ...(actor.kind === "agent"
        ? { conversationId: actor.conversationId }
        : {}),
      ...(decision.reason === "contribution_off"
        ? {
            role: decision.policy.role,
            source: decision.policy.contribute.source,
          }
        : {}),
    });
    return policyRefused(verb, decision);
  }

  /** An optional narrowing as a spreadable scope fragment. */
  function scopeOf(narrowing: MemoryHandleNarrowing | undefined): {
    scope?: MemoryScope;
  } {
    return narrowing?.scope === undefined ? {} : { scope: narrowing.scope };
  }

  /**
   * Whether a record is in the lifecycle set the caller asked for. The DEFAULT
   * is active only: the repository's `includeArchived` predicate is
   * `lifecycle <> 'archived'`, which still admits a proposal, and a bare slug
   * landing on a global note nobody has approved would deliver a record the
   * whole proposal boundary exists to hold back (R4, R9).
   */
  function admitsLifecycle(
    note: MemoryNote,
    options: z.infer<typeof memoryResolveOptionsSchema>,
  ): boolean {
    switch (note.lifecycle) {
      case "active":
        return true;
      case "archived":
        return options.includeArchived;
      case "proposed":
        return options.includeProposed;
    }
  }

  async function resolveHandle(
    handle: string,
    actor: MemoryActor,
    options: z.infer<typeof memoryResolveOptionsSchema>,
  ): Promise<MemoryResult<MemoryNote>> {
    const byId = await deps.repo.find(handle);
    if (
      byId !== null &&
      isVisible(byId, actor.visibility) &&
      admitsLifecycle(byId, options) &&
      (options.scope === undefined || byId.scope === options.scope)
    ) {
      return success(byId);
    }
    // The lifecycle narrowing is applied HERE rather than pushed into the query
    // because it also decides ambiguity: two notes sharing a slug where one is
    // a proposal are one match, not a disambiguation the caller must resolve.
    const matches = (
      await deps.repo.findByHandle(handle, {
        visibility: actor.visibility,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        includeArchived: options.includeArchived,
      })
    ).filter((note) => admitsLifecycle(note, options));
    const [only, ...rest] = matches;
    if (only === undefined) return notFound(handle);
    if (rest.length === 0) return success(only);
    return ambiguousHandle(handle, matches);
  }

  /** The public resolve: parse the actor and options, then resolve. */
  async function resolveForActor(
    handle: string,
    actor: MemoryActor,
    options: MemoryResolveOptions | undefined,
  ): Promise<MemoryResult<MemoryNote>> {
    const parsedActor = memoryActorSchema.safeParse(actor);
    if (!parsedActor.success) return validationFailed(parsedActor.error);
    const parsedOptions = memoryResolveOptionsSchema.safeParse(options ?? {});
    if (!parsedOptions.success) return validationFailed(parsedOptions.error);
    return resolveHandle(handle, parsedActor.data, parsedOptions.data);
  }

  /**
   * Whether an ACTIVE or proposed note of this scope owner already answers to
   * the handle as slug or alias (R4). Archived records do not hold a handle.
   * The repository's own slug check inside the write transaction is the race
   * backstop for slugs; aliases are only checked here.
   */
  /**
   * Archive the `state` notes of every OVER session incarnation the selector
   * admits, and report the durable ones alongside. This is the whole of
   * session-end's write: `finishSession` runs it over one project and
   * `reconcileSessionMemory` over all of them, so a completion and a
   * reconciliation can never disagree about what should have been retired.
   *
   * Reconciliation needs no queued work item because the recovery state is
   * already durable: a state note still active whose incarnation is over IS
   * the outstanding work, so any later sweep finds it and the sweep is
   * idempotent.
   */
  async function sweepOverIncarnations(
    selector: (note: MemoryNote) => boolean,
  ): Promise<{
    readonly scanned: number;
    readonly archived: MemoryNote[];
    readonly durable: MemoryNote[];
  }> {
    // The whole-table scan the review queue already uses: a delivery
    // visibility cannot express "every incarnation", and that is exactly the
    // set being reconciled.
    const notes = (
      await deps.repo.listAllScopes({ includeArchived: false })
    ).filter((note) => note.scope === "session" && selector(note));

    const overByIncarnation = new Map<string, boolean>();
    async function incarnationIsOver(note: MemoryNote): Promise<boolean> {
      if (
        note.projectPath === null ||
        note.sessionName === null ||
        note.sessionCreatedAt === null
      ) {
        return false;
      }
      const ref = {
        projectPath: note.projectPath,
        sessionName: note.sessionName,
        sessionCreatedAt: note.sessionCreatedAt,
      };
      const key = JSON.stringify([
        ref.projectPath,
        ref.sessionName,
        ref.sessionCreatedAt,
      ]);
      const cached = overByIncarnation.get(key);
      if (cached !== undefined) return cached;
      const over = await deps.sessions.isSessionIncarnationOver(ref);
      overByIncarnation.set(key, over);
      return over;
    }

    const archived: MemoryNote[] = [];
    const durable: MemoryNote[] = [];
    for (const note of notes) {
      // A running session's working state is still working state: archival is
      // gated on the incarnation actually being over, never on the caller's
      // say-so, so a premature call no-ops instead of retiring notes a live
      // session is still using.
      if (!(await incarnationIsOver(note))) continue;
      if (note.kind !== "state") {
        durable.push(note);
        continue;
      }
      // A state note is wholly perishable working state, so completion retires
      // it outright. The archive states no base revision: nobody is competing
      // for the note, and a session must not fail to close because its last
      // turn edited a note between this read and the write.
      const written = await deps.repo.archive({
        memoryId: note.id,
        revisionId: deps.generateId(),
        baseRevision: null,
        ...authorFields(SESSION_END_ACTOR),
        writtenAt: deps.now(),
      });
      const outcome = mapWrite(note.slug, written, null, note.scope, note.slug);
      if (!outcome.ok) {
        // With no stated base and an archive that cannot collide, the only way
        // here is a note deleted between the list and the write. One vanished
        // note must not strand the rest of the sweep.
        logger.warn("memory.session_end.archive_skipped", {
          memoryId: note.id,
          code: outcome.error.code,
        });
        continue;
      }
      archived.push(outcome.value);
      publishChange("archived", outcome.value, SESSION_END_ACTOR);
    }
    return { scanned: notes.length, archived, durable };
  }

  async function handleTakenInScope(
    handle: string,
    owner: ScopeOwner,
    exceptMemoryId: string | null,
  ): Promise<boolean> {
    const matches = await deps.repo.findByHandle(handle, {
      visibility: ownerVisibility(owner),
      scope: owner.scope,
      includeArchived: false,
    });
    return matches.some((note) => note.id !== exceptMemoryId);
  }

  async function chooseSlug(
    requested: string | undefined,
    hook: string,
    owner: ScopeOwner,
    predecessorId: string | null,
  ): Promise<MemoryResult<string>> {
    if (requested !== undefined) {
      if (await handleTakenInScope(requested, owner, predecessorId)) {
        return slugTaken(requested, owner.scope);
      }
      return success(requested);
    }
    const base = deriveMemorySlug(hook);
    let candidate = base;
    for (let ordinal = 2; ordinal <= MAX_SLUG_ORDINAL; ordinal += 1) {
      if (!(await handleTakenInScope(candidate, owner, predecessorId))) {
        return success(candidate);
      }
      candidate = suffixMemorySlug(base, ordinal);
    }
    return success(`${base}-${deps.generateId()}`);
  }

  async function overlapCandidates(
    created: MemoryNote,
    visibility: MemoryVisibility,
  ): Promise<MemoryOverlapCandidate[]> {
    const query = memoryOverlapQuery(created.hook, created.aliases);
    if (query === null) return [];
    const hits = await deps.repo.search(query, {
      visibility,
      includeArchived: false,
    });
    return hits
      .filter((hit) => hit.note.id !== created.id)
      .slice(0, MAX_OVERLAP_CANDIDATES)
      .map((hit) => ({
        memoryId: hit.note.id,
        slug: hit.note.slug,
        scope: hit.note.scope,
        hook: hit.note.hook,
        score: hit.score,
      }));
  }

  /** One mapping from the repository's write outcomes to the refusal vocabulary. */
  function mapWrite(
    handle: string,
    written: WriteMemoryNoteResult,
    baseRevision: number | null,
    scope: MemoryScope,
    slug: string,
  ): MemoryResult<MemoryNote> {
    switch (written.status) {
      case "written":
        return success(written.note);
      case "stale":
        logger.info("memory.service.stale_write_refused", {
          handle,
          currentRevision: written.currentRevision,
          baseRevision,
        });
        return staleRevision(written.currentRevision, baseRevision ?? 0, slug);
      case "slug_taken":
        return slugTaken(written.slug, scope);
      case "missing":
        return notFound(handle);
      case "body_too_large":
        return bodyTooLarge(written.limitBytes, written.actualBytes);
    }
  }

  /**
   * Archive, approve, and reject share one shape: resolve, gate, write a
   * lifecycle-only revision under the caller's stated base, publish on success.
   */
  async function lifecycleAct(input: {
    handle: string;
    actor: MemoryActor;
    baseRevision: number | null;
    change: MemoryChangeKind;
    gate?: (note: MemoryNote) => MemoryResult<MemoryNote> | null;
    write: "archive" | "activate";
    /**
     * How far the act's subject may be from active. Proposal decisions reach
     * everything, so a decision about an already-rejected proposal is refused
     * as stale rather than as missing.
     */
    reach?: { includeArchived: boolean; includeProposed: boolean };
    /** The caller's scope narrowing, when the handle was ambiguous. */
    narrowing?: MemoryHandleNarrowing | undefined;
  }): Promise<MemoryResult<MemoryNote>> {
    const resolved = await resolveHandle(input.handle, input.actor, {
      includeArchived: false,
      // A lifecycle act on a note the author proposed is the author's to make.
      includeProposed: true,
      ...(input.reach ?? {}),
      ...scopeOf(input.narrowing),
    });
    if (!resolved.ok) return resolved;
    const current = resolved.value;
    // A stated base that is no longer the head is refused before the gate and
    // the queued write: the act was decided about a revision that is gone. The
    // repository compares again inside the write queue, so a change landing
    // between this read and the write is refused there too.
    if (
      input.baseRevision !== null &&
      input.baseRevision !== current.revision
    ) {
      logger.info("memory.service.stale_write_refused", {
        handle: input.handle,
        currentRevision: current.revision,
        baseRevision: input.baseRevision,
      });
      return staleRevision(current.revision, input.baseRevision, current.slug);
    }
    const gated = input.gate?.(current) ?? null;
    if (gated !== null) return gated;

    const writtenAt = deps.now();
    const base = {
      memoryId: current.id,
      revisionId: deps.generateId(),
      baseRevision: input.baseRevision,
      ...authorFields(input.actor),
      writtenAt,
    };
    const written =
      input.write === "archive"
        ? await deps.repo.archive(base)
        : await deps.repo.update({ ...base, patch: { lifecycle: "active" } });
    const outcome = mapWrite(
      input.handle,
      written,
      input.baseRevision,
      current.scope,
      current.slug,
    );
    if (!outcome.ok) return outcome;

    logger.info("memory.service.lifecycle_changed", {
      memoryId: current.id,
      change: input.change,
      lifecycle: outcome.value.lifecycle,
      revision: outcome.value.revision,
      authorKind: input.actor.kind,
    });
    publishChange(input.change, outcome.value, input.actor);
    return outcome;
  }

  return {
    async create(request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryCaptureOutcome>(
        "create",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = createMemoryNoteRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const input = parsed.data;
      const writer = parsedActor.data;

      const ownership = ownerFor(input.scope, writer.visibility);
      if (!ownership.ok)
        return scopeUnavailable(input.scope, ownership.missing);
      const owner = ownership.owner;

      let predecessor: MemoryNote | null = null;
      if (input.supersedes !== null) {
        const resolved = await resolveHandle(input.supersedes, writer, {
          includeArchived: false,
          includeProposed: false,
        });
        if (!resolved.ok) return resolved;
        predecessor = resolved.value;
      }

      const slug = await chooseSlug(
        input.slug,
        input.hook,
        owner,
        predecessor?.id ?? null,
      );
      if (!slug.ok) return slug;

      // Ahead of the shape check so an oversized body is the typed refusal
      // naming the limit (R1.1), not one issue among the schema's.
      const bodyBytes = memoryBodyByteLength(input.body);
      if (bodyBytes > MEMORY_BODY_MAX_BYTES) {
        return bodyTooLarge(MEMORY_BODY_MAX_BYTES, bodyBytes);
      }

      const createdAt = deps.now();
      const id = deps.generateId();
      const reviewAfter = openingReviewLease(
        input.reviewAfter,
        input.kind,
        createdAt,
      );
      // The one narrow approval boundary in the write path (R9, D8): an agent's
      // global note is a proposal until a human activates it.
      const lifecycle: MemoryLifecycle =
        input.scope === "global" && writer.kind === "agent"
          ? "proposed"
          : "active";
      const candidate = {
        id,
        slug: slug.value,
        ...owner,
        kind: input.kind,
        hook: input.hook,
        body: input.body,
        statusNote:
          input.statusNote === null
            ? null
            : leasedStatusNote(input.statusNote, createdAt),
        aliases: input.aliases,
        indexMode: input.indexMode,
        lifecycle,
        reviewAfter,
        expiresAt: input.expiresAt,
        supersedesId: predecessor?.id ?? null,
        supersededById: null,
        createdBy: writer.kind,
        authorConversationId:
          writer.kind === "agent" ? writer.conversationId : null,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      // The cross-field rules (state kind at session scope only, no statusNote
      // on a state note, the body cap) are refused here as typed failures
      // rather than surfacing as the repository's schema exception.
      const shaped = memoryNoteSchema.safeParse(candidate);
      if (!shaped.success) return validationFailed(shaped.error);

      const created = await deps.repo.create({
        id,
        revisionId: deps.generateId(),
        slug: slug.value,
        scope: owner.scope,
        projectPath: owner.projectPath,
        sessionName: owner.sessionName,
        sessionCreatedAt: owner.sessionCreatedAt,
        kind: input.kind,
        hook: input.hook,
        body: input.body,
        statusNote: candidate.statusNote,
        aliases: input.aliases,
        indexMode: input.indexMode,
        lifecycle,
        reviewAfter,
        expiresAt: input.expiresAt,
        createdBy: writer.kind,
        authorConversationId: candidate.authorConversationId,
        supersedes:
          predecessor === null
            ? null
            : {
                memoryId: predecessor.id,
                archiveRevisionId: deps.generateId(),
                // An ordinary create states no predecessor revision: it is
                // replacing a note, not carrying its content forward, so
                // there is nothing an intervening edit could silently lose.
                // Promotion, which does carry content forward, states one.
                baseRevision: null,
              },
        createdAt,
      });
      switch (created.status) {
        case "slug_taken":
          return slugTaken(created.slug, owner.scope);
        case "supersedes_missing":
          return notFound(input.supersedes ?? created.memoryId);
        case "supersedes_stale":
          // A supersedes stale can only arise WITH a predecessor resolved.
          return staleRevision(
            created.currentRevision,
            0,
            predecessor?.slug ?? "the predecessor",
          );
        case "body_too_large":
          return bodyTooLarge(created.limitBytes, created.actualBytes);
        case "created":
          break;
      }
      const note = created.note;

      logger.info("memory.service.created", {
        memoryId: note.id,
        scope: note.scope,
        kind: note.kind,
        lifecycle: note.lifecycle,
        authorKind: writer.kind,
        supersedesId: note.supersedesId,
      });
      publishChange("created", note, writer);
      if (predecessor !== null) {
        // The predecessor's archive landed in the same transaction; its
        // announced state is the head as written, read back rather than
        // reconstructed.
        const archived = await deps.repo.find(predecessor.id);
        if (archived !== null) publishChange("superseded", archived, writer);
      }

      return success({
        note,
        advisories: {
          overlapCandidates: await overlapCandidates(note, writer.visibility),
          hookWarnings: assessMemoryHook(note.hook),
        },
      });
    },

    async resolve(handle, actor, options) {
      return resolveForActor(handle, actor, options);
    },

    async get(handle, actor, options) {
      const resolved = await resolveForActor(handle, actor, options);
      if (!resolved.ok) return resolved;
      return success({
        note: resolved.value,
        links: await deps.repo.listLinks(resolved.value.id),
      });
    },

    async list(request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const parsed = memoryNoteListRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const query = parsed.data;
      const notes = await deps.repo.list({
        visibility: parsedActor.data.visibility,
        ...(query.scope !== undefined ? { scope: query.scope } : {}),
        includeArchived:
          query.includeArchived || query.lifecycle === "archived",
      });
      return success(
        query.lifecycle === undefined
          ? notes
          : notes.filter((note) => note.lifecycle === query.lifecycle),
      );
    },

    async listRevisions(handle, actor, limit) {
      // History stays readable after archival, and after a rejection (R1.2).
      const resolved = await resolveForActor(handle, actor, {
        ...MEMORY_RESOLVE_ANY_LIFECYCLE,
      });
      if (!resolved.ok) return resolved;
      return success(await deps.repo.listRevisions(resolved.value.id, limit));
    },

    async update(handle, request, actor, narrowing) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryNote>(
        "update",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = updateMemoryNoteRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const input = parsed.data;
      const writer = parsedActor.data;

      const resolved = await resolveHandle(handle, writer, {
        includeArchived: false,
        // A write may address the proposal its author is awaiting approval on;
        // a bare READ may not, which is what keeps an unapproved global note
        // out of the surface an agent browses (R4, R9.1).
        includeProposed: true,
        ...scopeOf(narrowing),
      });
      if (!resolved.ok) return resolved;
      const current = resolved.value;

      if (input.body !== undefined) {
        const bodyBytes = memoryBodyByteLength(input.body);
        if (bodyBytes > MEMORY_BODY_MAX_BYTES) {
          return bodyTooLarge(MEMORY_BODY_MAX_BYTES, bodyBytes);
        }
      }

      const writtenAt = deps.now();
      const patch: MemoryNotePatch = {};
      if (input.hook !== undefined) patch.hook = input.hook;
      if (input.body !== undefined) patch.body = input.body;
      if (input.indexMode !== undefined) patch.indexMode = input.indexMode;
      if (input.reviewAfter !== undefined)
        patch.reviewAfter = input.reviewAfter;
      if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
      if (input.aliases !== undefined) patch.aliases = input.aliases;

      if (input.slug !== undefined && input.slug !== current.slug) {
        if (
          await handleTakenInScope(input.slug, ownerOf(current), current.id)
        ) {
          return slugTaken(input.slug, current.scope);
        }
        patch.slug = input.slug;
        // A rename leaves the old slug behind as an alias, so every stored
        // reference and every remembered handle keeps resolving (R4).
        const aliases = input.aliases ?? current.aliases;
        if (!aliases.includes(current.slug)) {
          if (aliases.length >= MEMORY_MAX_ALIASES) {
            return failure({
              code: "validation_failed",
              message: `Renaming would keep ${current.slug} as an alias, exceeding the ${MEMORY_MAX_ALIASES}-alias limit.`,
              rationale:
                "A rename keeps the old slug as an alias so existing references resolve, and aliases are capped.",
              instruction: "Drop an alias in the same update, then rename.",
              issues: [
                {
                  path: "aliases",
                  message: `at most ${MEMORY_MAX_ALIASES} aliases`,
                },
              ],
            });
          }
          patch.aliases = [...aliases, current.slug];
        }
      }

      if (input.statusNote === null) {
        patch.statusNote = null;
      } else if (
        input.statusNote !== undefined &&
        input.statusNote !== current.statusNote?.text
      ) {
        // New text is a fresh perishable claim and takes a fresh lease; the
        // same text is left alone so an unrelated edit never re-leases it.
        patch.statusNote = leasedStatusNote(input.statusNote, writtenAt);
      }

      const shaped = memoryNoteSchema.safeParse({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: writtenAt,
      });
      if (!shaped.success) return validationFailed(shaped.error);

      const written = await deps.repo.update({
        memoryId: current.id,
        revisionId: deps.generateId(),
        baseRevision: input.baseRevision,
        patch,
        ...authorFields(writer),
        writtenAt,
      });
      const outcome = mapWrite(
        handle,
        written,
        input.baseRevision,
        current.scope,
        current.slug,
      );
      if (!outcome.ok) return outcome;

      logger.info("memory.service.updated", {
        memoryId: current.id,
        revision: outcome.value.revision,
        renamed: patch.slug !== undefined,
        authorKind: writer.kind,
      });
      publishChange("updated", outcome.value, writer);
      return outcome;
    },

    async link(handle, request, actor, narrowing) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryLinkOutcome>(
        "link",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = linkMemoryNoteRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const input = parsed.data;
      const writer = parsedActor.data;

      const resolved = await resolveHandle(handle, writer, {
        includeArchived: false,
        // A write may address the proposal its author is awaiting approval on;
        // a bare READ may not, which is what keeps an unapproved global note
        // out of the surface an agent browses (R4, R9.1).
        includeProposed: true,
        ...scopeOf(narrowing),
      });
      if (!resolved.ok) return resolved;
      const note = resolved.value;

      // Link identity is decided inside the serialized write, so re-linking
      // the same note, kind, and artifact lands on the row that already
      // exists rather than accumulating a duplicate.
      const added = await deps.repo.addLink({
        id: deps.generateId(),
        memoryId: note.id,
        kind: input.kind,
        artifact: input.artifact,
        createdAt: deps.now(),
      });
      if (added.status === "missing") return notFound(handle);
      const link = added.link;

      logger.info("memory.service.linked", {
        memoryId: note.id,
        linkId: link.id,
        kind: link.kind,
        artifactKind: link.artifact.kind,
        authorKind: writer.kind,
      });
      publishChange("linked", note, writer, { id: link.id, kind: link.kind });
      return success({ link, note });
    },

    async unlink(handle, request, actor, narrowing) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryLinkOutcome>(
        "unlink",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = unlinkMemoryNoteRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const input = parsed.data;
      const writer = parsedActor.data;

      const resolved = await resolveHandle(handle, writer, {
        includeArchived: false,
        // A write may address the proposal its author is awaiting approval on;
        // a bare READ may not, which is what keeps an unapproved global note
        // out of the surface an agent browses (R4, R9.1).
        includeProposed: true,
        ...scopeOf(narrowing),
      });
      if (!resolved.ok) return resolved;
      const note = resolved.value;

      // Matched among the note's own links only, so a link id or identity
      // from another note resolves to nothing here.
      const links = await deps.repo.listLinks(note.id);
      const target =
        "linkId" in input
          ? links.find((link) => link.id === input.linkId)
          : links.find(
              (link) =>
                link.kind === input.kind &&
                sameArtifact(link.artifact, input.artifact),
            );
      if (target === undefined) return linkNotFound();

      const removed = await deps.repo.removeLink(target.id);
      if (removed === null) return linkNotFound();

      logger.info("memory.service.unlinked", {
        memoryId: note.id,
        linkId: removed.id,
        kind: removed.kind,
        authorKind: writer.kind,
      });
      publishChange("unlinked", note, writer, {
        id: removed.id,
        kind: removed.kind,
      });
      return success({ link: removed, note });
    },

    async archive(handle, request, actor, narrowing) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryNote>(
        "archive",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = memoryLifecycleActRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      return lifecycleAct({
        handle,
        actor: parsedActor.data,
        baseRevision: parsed.data.baseRevision,
        change: "archived",
        narrowing,
        write: "archive",
      });
    },

    async restore(handle, request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryNote>(
        "restore",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = restoreMemoryNoteRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const writer = parsedActor.data;

      // A restore reaches archived notes: bringing one back is the point.
      const resolved = await resolveHandle(handle, writer, {
        includeArchived: true,
        includeProposed: false,
      });
      if (!resolved.ok) return resolved;
      const current = resolved.value;

      const written = await deps.repo.restore({
        memoryId: current.id,
        revisionId: deps.generateId(),
        baseRevision: parsed.data.baseRevision,
        restoreFromRevision: parsed.data.revision,
        ...authorFields(writer),
        writtenAt: deps.now(),
      });
      if (written.status === "revision_missing") {
        return revisionNotFound(written.revision);
      }
      const outcome = mapWrite(
        handle,
        written,
        parsed.data.baseRevision,
        current.scope,
        current.slug,
      );
      if (!outcome.ok) return outcome;

      logger.info("memory.service.restored", {
        memoryId: current.id,
        restoredFromRevision: parsed.data.revision,
        revision: outcome.value.revision,
        authorKind: writer.kind,
      });
      publishChange("restored", outcome.value, writer);
      return outcome;
    },

    async delete(handle, actor, narrowing) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryNote>(
        "delete",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const writer = parsedActor.data;

      // Permanent delete reaches every lifecycle: the Library destroys rejected
      // proposals and retired records, and the surface already confirmed it.
      const resolved = await resolveHandle(handle, writer, {
        ...MEMORY_RESOLVE_ANY_LIFECYCLE,
        ...scopeOf(narrowing),
      });
      if (!resolved.ok) return resolved;

      const deleted = await deps.repo.delete(resolved.value.id);
      if (deleted === null) return notFound(handle);

      logger.info("memory.service.deleted", {
        memoryId: deleted.id,
        scope: deleted.scope,
        lifecycle: deleted.lifecycle,
        authorKind: writer.kind,
      });
      publishChange("deleted", deleted, writer);
      return success(deleted);
    },

    async markReviewed(handle, request, actor, narrowing) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryReviewOutcome>(
        "mark-reviewed",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = markMemoryReviewedRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const input = parsed.data;
      const writer = parsedActor.data;

      const resolved = await resolveHandle(handle, writer, {
        includeArchived: false,
        // A write may address the proposal its author is awaiting approval on;
        // a bare READ may not, which is what keeps an unapproved global note
        // out of the surface an agent browses (R4, R9.1).
        includeProposed: true,
        ...scopeOf(narrowing),
      });
      if (!resolved.ok) return resolved;
      const current = resolved.value;
      // A stated base that is no longer the head is refused before anything
      // is written or re-recorded: the review was decided about a revision
      // that is gone. The repository compares again inside the write queue.
      if (
        input.baseRevision !== null &&
        input.baseRevision !== current.revision
      ) {
        logger.info("memory.service.stale_write_refused", {
          handle,
          currentRevision: current.revision,
          baseRevision: input.baseRevision,
        });
        return staleRevision(
          current.revision,
          input.baseRevision,
          current.slug,
        );
      }

      const reviewedAt = deps.now();
      let patch: MemoryNotePatch;
      if (input.target === "note") {
        patch = {
          reviewAfter:
            current.reviewAfter === null
              ? null
              : refreshedMemoryLease(
                  current.reviewAfter,
                  reviewedAt,
                  defaultMemoryReviewLeaseMs(current.kind),
                ),
        };
      } else {
        const status = current.statusNote;
        if (status === null) return noStatusNote();
        // The lease moves; the claim's own updated-at does not, so its
        // rendered age still says when it was written.
        patch = {
          statusNote: {
            ...status,
            reviewAfter: refreshedMemoryLease(
              status.reviewAfter,
              reviewedAt,
              MEMORY_STATUS_NOTE_LEASE_MS,
            ),
          },
        };
      }

      const written = await deps.repo.update({
        memoryId: current.id,
        revisionId: deps.generateId(),
        baseRevision: input.baseRevision,
        patch,
        ...authorFields(writer),
        writtenAt: reviewedAt,
      });
      const outcome = mapWrite(
        handle,
        written,
        input.baseRevision,
        current.scope,
        current.slug,
      );
      if (!outcome.ok) return outcome;

      logger.info("memory.service.reviewed", {
        memoryId: current.id,
        target: input.target,
        revision: outcome.value.revision,
        authorKind: writer.kind,
      });
      publishChange("reviewed", outcome.value, writer);
      return success({
        note: outcome.value,
        statusReLease:
          input.target === "statusNote" ? outcome.value.statusNote : null,
      });
    },

    async approveProposal(handle, request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryNote>(
        "approve-proposal",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = memoryProposalDecisionRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      if (parsedActor.data.kind !== "user") {
        return humanActRequired("approve-proposal");
      }
      return lifecycleAct({
        handle,
        actor: parsedActor.data,
        baseRevision: parsed.data.baseRevision,
        change: "proposal-approved",
        gate: (note) =>
          note.lifecycle === "proposed" ? null : notProposed(note.lifecycle),
        write: "activate",
        reach: MEMORY_RESOLVE_ANY_LIFECYCLE,
      });
    },

    async rejectProposal(handle, request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryNote>(
        "reject-proposal",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = memoryProposalDecisionRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      if (parsedActor.data.kind !== "user") {
        return humanActRequired("reject-proposal");
      }
      return lifecycleAct({
        handle,
        actor: parsedActor.data,
        baseRevision: parsed.data.baseRevision,
        change: "proposal-rejected",
        gate: (note) =>
          note.lifecycle === "proposed" ? null : notProposed(note.lifecycle),
        write: "archive",
        reach: MEMORY_RESOLVE_ANY_LIFECYCLE,
      });
    },

    async finishSession(input) {
      const parsed = memorySessionEndInputSchema.safeParse(input);
      if (!parsed.success) return validationFailed(parsed.error);
      const { projectPath, session } = parsed.data;

      function isCompletingIncarnation(note: MemoryNote): boolean {
        return (
          note.sessionName === session.sessionName &&
          note.sessionCreatedAt === session.sessionCreatedAt
        );
      }

      // The whole project's session notes, not just the completing
      // incarnation's. Completion is one of the moments this project's memory
      // is reconciled: an earlier completion whose memory step never landed
      // leaves state notes active otherwise.
      const swept = await sweepOverIncarnations(
        (note) => note.projectPath === projectPath,
      );

      const archived: MemoryNote[] = [];
      const reconciled: MemoryNote[] = [];
      for (const note of swept.archived) {
        (isCompletingIncarnation(note) ? archived : reconciled).push(note);
      }
      const promotionCandidates = swept.durable.filter(
        (note) =>
          isPromotableSessionNote(note) && isCompletingIncarnation(note),
      );

      logger.info("memory.session_end.finalized", {
        projectPath,
        sessionName: session.sessionName,
        sessionCreatedAt: session.sessionCreatedAt,
        scanned: swept.scanned,
        archived: archived.length,
        reconciled: reconciled.length,
        promotionCandidates: promotionCandidates.length,
      });
      return success({ archived, promotionCandidates, reconciled });
    },

    async reconcileSessionMemory() {
      const swept = await sweepOverIncarnations(() => true);
      logger.info("memory.session_end.reconciled", {
        scanned: swept.scanned,
        archived: swept.archived.length,
      });
      return success({ archived: swept.archived });
    },

    async promote(handle, request, actor) {
      const parsedActor = memoryActorSchema.safeParse(actor);
      if (!parsedActor.success) return validationFailed(parsedActor.error);
      const refused = await refuseIfContributionOff<MemoryPromotionOutcome>(
        "promote",
        parsedActor.data,
      );
      if (refused !== null) return refused;
      const parsed = promoteMemoryNoteRequestSchema.safeParse(request);
      if (!parsed.success) return validationFailed(parsed.error);
      const input = parsed.data;
      const writer = parsedActor.data;

      // Promotion's subject is a session note, so the handle resolves in
      // session scope first: a project note already holding the same slug is
      // the COLLISION this act must refuse, not a second candidate for the
      // same read (R4.2). The unnarrowed retry keeps a handle that is simply
      // not promotable refused for what it is rather than as missing.
      const resolved = await resolveHandle(handle, writer, {
        includeArchived: false,
        includeProposed: false,
        scope: "session",
      });
      const subject = resolved.ok
        ? resolved
        : await resolveHandle(handle, writer, {
            includeArchived: false,
            includeProposed: false,
          });
      if (!subject.ok) return subject;
      const predecessor = subject.value;
      if (predecessor.scope !== "session") {
        return notPromotable(
          `it is ${predecessor.scope}-scoped, not a session note`,
        );
      }
      if (!isPromotableSessionNote(predecessor)) {
        return notPromotable(
          predecessor.kind === "state"
            ? "a state note is wholly perishable and dies with its session"
            : `its lifecycle is ${predecessor.lifecycle}`,
        );
      }

      const ownership = ownerFor("project", writer.visibility);
      if (!ownership.ok) return scopeUnavailable("project", ownership.missing);
      const owner = ownership.owner;

      const slug = input.slug ?? predecessor.slug;
      const aliases = input.aliases ?? predecessor.aliases;
      // Every handle the promoted note would answer to has to be free in the
      // project scope: a collision is the promoter's decision, and a shadowed
      // alias would leave the project note permanently ambiguous (R4, R10).
      // This read refuses early with the collision named; the same handles are
      // re-checked inside the create transaction, because only there can the
      // check and the predecessor's archive be atomic.
      const claimedHandles = [slug, ...aliases];
      for (const claimed of claimedHandles) {
        if (await handleTakenInScope(claimed, owner, null)) {
          return promotionHandleTaken(claimed);
        }
      }

      const createdAt = deps.now();
      const id = deps.generateId();
      // An unstated status line carries forward WITH its lease and its own
      // updated-at: promoting a claim is not re-verifying it, so its age and
      // its review date are the ones it already had. Stated text is a fresh
      // claim and re-leases.
      const statusNote =
        input.statusNote === undefined
          ? predecessor.statusNote
          : input.statusNote === null
            ? null
            : leasedStatusNote(input.statusNote, createdAt);
      const candidate = {
        id,
        slug,
        ...owner,
        kind: predecessor.kind,
        hook: input.hook ?? predecessor.hook,
        body: input.body ?? predecessor.body,
        statusNote,
        aliases,
        indexMode: input.indexMode ?? predecessor.indexMode,
        lifecycle: "active" as const,
        reviewAfter: predecessor.reviewAfter,
        expiresAt: predecessor.expiresAt,
        supersedesId: predecessor.id,
        supersededById: null,
        createdBy: writer.kind,
        authorConversationId:
          writer.kind === "agent" ? writer.conversationId : null,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      const shaped = memoryNoteSchema.safeParse(candidate);
      if (!shaped.success) return validationFailed(shaped.error);

      const created = await deps.repo.create({
        id,
        revisionId: deps.generateId(),
        slug,
        scope: owner.scope,
        projectPath: owner.projectPath,
        sessionName: owner.sessionName,
        sessionCreatedAt: owner.sessionCreatedAt,
        kind: candidate.kind,
        hook: candidate.hook,
        body: candidate.body,
        statusNote,
        aliases,
        indexMode: candidate.indexMode,
        lifecycle: "active",
        reviewAfter: candidate.reviewAfter,
        expiresAt: candidate.expiresAt,
        createdBy: writer.kind,
        authorConversationId: candidate.authorConversationId,
        supersedes: {
          memoryId: predecessor.id,
          archiveRevisionId: deps.generateId(),
          // Unstated defaults to the revision this act just resolved, not to
          // "compete with nobody": promotion copies the predecessor's content
          // forward, so an edit landing between that read and this write would
          // be archived as the predecessor's head and silently dropped from
          // the successor. The caller states a base only to pin an older read.
          baseRevision:
            input.baseRevision === undefined
              ? predecessor.revision
              : input.baseRevision,
        },
        requireFreeHandles: claimedHandles,
        createdAt,
      });
      switch (created.status) {
        case "slug_taken":
          return promotionHandleTaken(created.slug);
        case "supersedes_missing":
          return notFound(handle);
        case "supersedes_stale":
          return staleRevision(
            created.currentRevision,
            input.baseRevision ?? predecessor.revision,
            predecessor.slug,
          );
        case "body_too_large":
          return bodyTooLarge(created.limitBytes, created.actualBytes);
        case "created":
          break;
      }

      // The predecessor's archive and forward pointer landed in the same
      // transaction; both surfaces report the head as written, read back
      // rather than reconstructed.
      const superseded = await deps.repo.find(predecessor.id);
      if (superseded === null) return notFound(handle);

      logger.info("memory.service.promoted", {
        memoryId: created.note.id,
        supersededId: superseded.id,
        sessionName: predecessor.sessionName,
        sessionCreatedAt: predecessor.sessionCreatedAt,
        kind: created.note.kind,
        rewritten:
          input.hook !== undefined ||
          input.body !== undefined ||
          input.statusNote !== undefined ||
          input.slug !== undefined,
        authorKind: writer.kind,
      });
      publishChange("promoted", created.note, writer);
      publishChange("superseded", superseded, writer);
      return success({ promoted: created.note, superseded });
    },
  };
}
