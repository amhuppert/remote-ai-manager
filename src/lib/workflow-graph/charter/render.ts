import { createHash } from "node:crypto";

import { truncate } from "@/lib/shared/truncate";
import type {
  SourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";

// Max characters of a source description rendered into the budget-bounded
// digest. The full untruncated description lives in renderCharterMarkdown /
// charter.md; the digest is a compact pointer, not the whole charter.
const DIGEST_DESCRIPTION_BUDGET = 200;

// Fixed application-rule text shared by implementer and validator prompts. It
// encodes the precedence semantics (5.1) and the validator deferral behavior so
// every agent resolves a source-vs-acceptance-criterion conflict identically.
const APPLICATION_RULE = [
  "## Applying the source-of-truth hierarchy",
  "When two sources conflict, the higher-ranked source (lower rank number) prevails over the lower-ranked one, evaluated within each source's applicability scope.",
  "When an acceptance criterion conflicts with a higher-ranked source and the implementation follows the higher-ranked source, do not fail the implementer for that mismatch; instead flag the conflicting acceptance criterion and record the conflict (criterion, prevailing source, resolution) in the validation summary.",
  "Sources marked external-readonly are read-only and permission-gated: never read, write, or verify them automatically — explicit human permission is required for any out-of-worktree access.",
].join("\n");

function rankedSources(charter: WorkflowCharter): SourceOfTruth[] {
  return [...charter.sourcesOfTruth].sort((a, b) => a.rank - b.rank);
}

function renderDigestSourceLine(source: SourceOfTruth): string {
  const parts = [
    `${source.rank}. **${source.label}** (${source.type}, \`${source.locator}\`)`,
    `   ${truncate(source.description, DIGEST_DESCRIPTION_BUDGET, {
      countEllipsisInBudget: true,
      trimEnd: true,
    })}`,
  ];
  if (source.appliesTo) {
    parts.push(`   Applies to: ${source.appliesTo}`);
  }
  const readOnly = source.accessPolicy === "external-readonly";
  parts.push(
    `   Access: ${source.accessPolicy}${readOnly ? " (read-only, permission-gated)" : ""}`,
  );
  return parts.join("\n");
}

export function renderCharterDigest(charter: WorkflowCharter): string {
  const sections: string[] = [
    "# Workflow Charter",
    `## Mission\n${charter.mission}`,
    [
      "## Source-of-truth hierarchy (highest authority first)",
      ...rankedSources(charter).map(renderDigestSourceLine),
    ].join("\n"),
  ];

  if (charter.nonGoals && charter.nonGoals.length > 0) {
    sections.push(
      ["## Non-goals", ...charter.nonGoals.map((goal) => `- ${goal}`)].join(
        "\n",
      ),
    );
  }

  sections.push(APPLICATION_RULE);

  return sections.join("\n\n");
}

// Path of the full charter document mirrored into the worktree by the charter
// service (shared-documents.ts SHARED_DOCUMENT_DIRECTORY + charter.md).
export const CHARTER_DOCUMENT_PATH = ".cc/graph-workflow-docs/charter.md";

// Charter section prepended at the top of the implementer and validator prompts:
// the budget-bounded digest plus a pointer to the full charter.md. Role-specific
// instructions (e.g. the implementer's citation requirement) are appended to the
// pointer block via `extraInstructions`.
export function renderCharterPromptSection(
  charter: WorkflowCharter,
  extraInstructions: string[] = [],
): string {
  return [
    renderCharterDigest(charter),
    [
      `Full charter: read \`${CHARTER_DOCUMENT_PATH}\` on demand.`,
      ...extraInstructions,
    ].join("\n"),
  ].join("\n\n");
}

function renderMarkdownSourceEntry(source: SourceOfTruth): string {
  const lines = [
    `### ${source.rank}. ${source.label}`,
    `- id: \`${source.id}\``,
    `- type: ${source.type}`,
    `- locator: \`${source.locator}\``,
    `- access policy: ${source.accessPolicy}`,
  ];
  if (source.appliesTo) {
    lines.push(`- applies to: ${source.appliesTo}`);
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

export function renderCharterMarkdown(charter: WorkflowCharter): string {
  const sections: Array<string | null> = [
    "# Workflow Charter",
    `## Mission\n${charter.mission}`,
    renderBulletSection("Conventions", charter.conventions),
    renderBulletSection("Non-goals", charter.nonGoals),
    renderBulletSection("Vocabulary", charter.vocabulary),
    renderProseSection("Test strategy", charter.testStrategy),
    renderBulletSection("Known ambiguities", charter.knownAmbiguities),
    [
      "## Source-of-truth hierarchy (highest authority first)",
      ...rankedSources(charter).map(renderMarkdownSourceEntry),
    ].join("\n\n"),
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
