import { createHash } from "node:crypto";

import { truncate } from "@/lib/shared/truncate";
import type {
  CharterAmendment,
  CharterInvariant,
  PersistedSourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import { sourceScopeContextIds } from "@/lib/workflows/charter-schemas";

// Max characters of a source description rendered into the budget-bounded
// digest. The full untruncated description lives in renderCharterMarkdown /
// charter.md; the digest is a compact pointer, not the whole charter.
const DIGEST_DESCRIPTION_BUDGET = 200;

function rankedSources(charter: WorkflowCharter): PersistedSourceOfTruth[] {
  return [...charter.sourcesOfTruth].sort((a, b) => a.rank - b.rank);
}

// The sources an agent working THIS context receives: global sources plus
// sources scoped to the context. Conflicts among sources are resolved at plan
// time, so the prompt path never renders out-of-scope entries or precedence
// rules. A legacy prose `appliesTo` carries no filterable ids and is treated
// as global (sourceScopeContextIds returns null for it).
function contextScopedSources(
  charter: WorkflowCharter,
  contextId: string,
): PersistedSourceOfTruth[] {
  return rankedSources(charter).filter((source) => {
    const scope = sourceScopeContextIds(source);
    return scope === null || scope.includes(contextId);
  });
}

/**
 * Whether a worktree document belongs in this context's view. A document that
 * is the locator of a context-scoped source takes that source's scope, so the
 * charter stays the single owner of who a source is for; a document no source
 * names is everyone's.
 */
export function isDocumentInContextScope(
  charter: WorkflowCharter,
  contextId: string,
  relativePath: string,
): boolean {
  const sources = charter.sourcesOfTruth.filter(
    (source) => source.locator === relativePath,
  );
  return (
    sources.length === 0 ||
    sources.some((source) => {
      const scope = sourceScopeContextIds(source);
      return scope === null || scope.includes(contextId);
    })
  );
}

/** A source's applicability note: prose passes through, structured scopes join. */
function appliesToNote(source: PersistedSourceOfTruth): string | null {
  if (source.appliesTo === undefined) return null;
  if (typeof source.appliesTo === "string") return source.appliesTo;
  return source.appliesTo.contextIds.join(", ");
}

function hasScopedInvariants(
  invariants: readonly CharterInvariant[] | undefined,
): boolean {
  return (
    invariants?.some((invariant) => invariant.appliesTo !== undefined) ?? false
  );
}

function invariantHeading(
  invariants: readonly CharterInvariant[] | undefined,
): string {
  return hasScopedInvariants(invariants)
    ? "Invariants (global and context-scoped)"
    : "Invariants (hold for every change)";
}

function renderInvariant(
  invariant: CharterInvariant,
  showScopes: boolean,
): string {
  if (!showScopes) {
    return `\`${invariant.id}\` — ${invariant.statement}`;
  }

  const scope = invariant.appliesTo
    ? `applies to: ${invariant.appliesTo.contextIds.join(", ")}`
    : "global";
  return `\`${invariant.id}\` — ${invariant.statement} (${scope})`;
}

// The digest's source line is deliberately reference-shaped: rank, label,
// locator, and a budget-bounded description. Scope and access bookkeeping
// never render here — scoping is applied by filtering (contextScopedSources),
// and access policy is a retired authored field preserved only for legacy
// persisted charters (rendered in renderCharterMarkdown, not in prompts).
function renderDigestSourceLine(source: PersistedSourceOfTruth): string {
  return [
    `${source.rank}. **${source.label}** (${source.type}, \`${source.locator}\`)`,
    `   ${truncate(source.description, DIGEST_DESCRIPTION_BUDGET, {
      countEllipsisInBudget: true,
      trimEnd: true,
    })}`,
  ].join("\n");
}

/**
 * The live-amendment history section (docs/design/cc-cli/07), oldest first so
 * the narrative reads forward. Rendered ONLY into the full charter.md and the
 * durable record surfaces: agents read the current rules from their prompt and
 * consult the history in `charter.md` on demand. Returns null when the run has
 * no amendments so pre-amendment output stays byte-identical.
 */
function renderAmendmentLog(
  amendments: readonly CharterAmendment[],
): string | null {
  if (amendments.length === 0) {
    return null;
  }
  return [
    "## Amendment log",
    ...amendments.map(
      (amendment) =>
        `${amendment.seq}. ${amendment.amendedAt.slice(0, 10)} — changed ${amendment.fieldsChanged.join(", ")}: ${amendment.rationale}`,
    ),
  ].join("\n");
}

/**
 * The budget-bounded charter digest for one rendering context: mission,
 * applicable invariants, the context's sources (global + scoped to it), and
 * non-goals. Applicability is resolved here by filtering, not delegated to the
 * agent as a rule — source conflicts are resolved at plan time, so the digest
 * carries no precedence, deferral, or access-policy instructions and no
 * amendment history (charter.md keeps all of those).
 */
export function renderCharterDigest(
  charter: WorkflowCharter,
  contextId: string,
): string {
  const sections: string[] = [
    "# Workflow Charter",
    `## Mission\n${charter.mission}`,
  ];

  // Invariants render ahead of the source hierarchy: they are active per-change
  // obligations, not precedence bookkeeping.
  if (charter.invariants && charter.invariants.length > 0) {
    const showScopes = hasScopedInvariants(charter.invariants);
    sections.push(
      [
        `## ${invariantHeading(charter.invariants)}`,
        ...charter.invariants.map(
          (invariant) => `- ${renderInvariant(invariant, showScopes)}`,
        ),
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Source-of-truth hierarchy (highest authority first)",
      ...contextScopedSources(charter, contextId).map(renderDigestSourceLine),
    ].join("\n"),
  );

  if (charter.nonGoals && charter.nonGoals.length > 0) {
    sections.push(
      ["## Non-goals", ...charter.nonGoals.map((goal) => `- ${goal}`)].join(
        "\n",
      ),
    );
  }

  return sections.join("\n\n");
}

// Path of the full charter document mirrored into the worktree by the charter
// service (shared-documents.ts SHARED_DOCUMENT_DIRECTORY + charter.md).
export const CHARTER_DOCUMENT_PATH = ".cc/graph-workflow-docs/charter.md";

// Charter section prepended at the top of the implementer and validator
// prompts: the rendering context's budget-bounded digest plus a pointer to the
// full charter.md. `contextId` is the LOGICAL authored context id (a loop
// instance passes its authored template id) so scoped sources resolve the same
// ids the plan declared. Role-specific instructions (e.g. the implementer's
// citation requirement) are appended to the pointer block via
// `extraInstructions`.
export function renderCharterPromptSection(
  charter: WorkflowCharter,
  contextId: string,
  extraInstructions: string[] = [],
): string {
  return [
    renderCharterDigest(charter, contextId),
    [
      `Full charter: read \`${CHARTER_DOCUMENT_PATH}\` on demand.`,
      ...extraInstructions,
    ].join("\n"),
  ].join("\n\n");
}

function renderMarkdownSourceEntry(source: PersistedSourceOfTruth): string {
  const lines = [
    `### ${source.rank}. ${source.label}`,
    `- id: \`${source.id}\``,
    `- type: ${source.type}`,
    `- locator: \`${source.locator}\``,
  ];
  if (source.accessPolicy !== undefined) {
    lines.push(`- access policy: ${source.accessPolicy}`);
  }
  const applies = appliesToNote(source);
  if (applies !== null) {
    lines.push(`- applies to: ${applies}`);
  }
  lines.push("", source.description);
  return lines.join("\n");
}

function renderBulletSection(
  heading: string,
  items: string[] | undefined,
): string | null {
  if (!items || items.length === 0) {
    return null;
  }
  return [`## ${heading}`, ...items.map((item) => `- ${item}`)].join("\n");
}

function renderProseSection(
  heading: string,
  body: string | undefined,
): string | null {
  if (!body) {
    return null;
  }
  return `## ${heading}\n${body}`;
}

export function renderCharterMarkdown(
  charter: WorkflowCharter,
  amendments: readonly CharterAmendment[] = [],
): string {
  return renderCharter(charter, amendments, rankedSources(charter));
}

/**
 * The charter as written into the worktree, where every context's agents can
 * read it: context-scoped sources are left out because each context's prompt
 * already lists the ones that apply to it, and naming them here would
 * advertise a source to the contexts it was scoped away from.
 */
export function renderCharterDocument(
  charter: WorkflowCharter,
  amendments: readonly CharterAmendment[] = [],
): string {
  const globalSources = rankedSources(charter).filter(
    (source) => sourceScopeContextIds(source) === null,
  );
  return renderCharter(
    charter,
    amendments,
    globalSources,
    globalSources.length < charter.sourcesOfTruth.length
      ? "Sources scoped to specific contexts are listed in the prompts of the contexts they apply to."
      : null,
  );
}

function renderCharter(
  charter: WorkflowCharter,
  amendments: readonly CharterAmendment[],
  sources: readonly PersistedSourceOfTruth[],
  scopedSourcesNote: string | null = null,
): string {
  const showInvariantScopes = hasScopedInvariants(charter.invariants);
  const sections: Array<string | null> = [
    "# Workflow Charter",
    `## Mission\n${charter.mission}`,
    renderBulletSection(
      invariantHeading(charter.invariants),
      charter.invariants?.map((invariant) =>
        renderInvariant(invariant, showInvariantScopes),
      ),
    ),
    renderBulletSection("Conventions", charter.conventions),
    renderBulletSection("Non-goals", charter.nonGoals),
    renderBulletSection("Vocabulary", charter.vocabulary),
    renderProseSection("Test strategy", charter.testStrategy),
    renderBulletSection("Known ambiguities", charter.knownAmbiguities),
    [
      "## Source-of-truth hierarchy (highest authority first)",
      ...sources.map(renderMarkdownSourceEntry),
      ...(scopedSourcesNote !== null ? [scopedSourcesNote] : []),
    ].join("\n\n"),
    renderAmendmentLog(amendments),
  ];

  return sections.filter((section) => section !== null).join("\n\n");
}

// Recursively produce a canonical string with object keys sorted at every depth
// so two deeply-equal charters serialize identically regardless of property
// insertion order. Arrays preserve order (source ranking is meaningful and we
// sort by rank before hashing).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.map(([key, v]) => [key, canonicalize(v)]);
  }
  return value;
}

export function computeCharterHash(charter: WorkflowCharter): string {
  const canonical = canonicalize({
    ...charter,
    sourcesOfTruth: rankedSources(charter),
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
