import {
  findReservedSequence,
  renderProfileBlock,
} from "@/lib/agent-profiles/block";
import {
  agentProfileContentSchema,
  type AgentProfileAudience,
  type AgentProfileContent,
  type AgentProfileLibraryEntry,
  type AgentProfileTier,
} from "@/lib/agent-profiles/schemas";

/**
 * What the profile editor holds while it is being edited, and what that means.
 *
 * A draft is not `AgentProfileContent`: tags are one comma-separated field in
 * the form and an array in the schema, and every field can be transiently
 * invalid. Keeping the two shapes distinct is what lets validation run on every
 * keystroke without the editor ever holding a half-parsed record.
 */
export interface AgentProfileDraft {
  name: string;
  description: string;
  instructions: string;
  recommendedFor: AgentProfileAudience[];
  /** Comma-separated in the form; split and trimmed at validation. */
  tagsText: string;
}

export function emptyAgentProfileDraft(): AgentProfileDraft {
  return {
    name: "",
    description: "",
    instructions: "",
    recommendedFor: [],
    tagsText: "",
  };
}

export function agentProfileDraftFromEntry(
  entry: AgentProfileLibraryEntry,
): AgentProfileDraft {
  return {
    name: entry.name,
    description: entry.description,
    instructions: entry.instructions,
    recommendedFor: [...entry.recommendedFor],
    tagsText: entry.tags.join(", "),
  };
}

function parseTags(tagsText: string): string[] {
  return tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Errors keyed by the draft field the author edits, not by schema path. */
export type AgentProfileDraftErrors = Partial<
  Record<keyof AgentProfileDraft | "tags", string>
>;

export type AgentProfileDraftValidation =
  | { ok: true; content: AgentProfileContent }
  | { ok: false; errors: AgentProfileDraftErrors };

/**
 * Validate a draft against the domain schema, plus the composer's containment
 * rule.
 *
 * The reserved-sequence check runs here as well as at save because the library
 * service refuses such a record anyway (`findReservedSequence` on every write);
 * catching it in the form turns a round trip into an inline message, and the
 * server refusal stays the authority.
 */
export function validateAgentProfileDraft(
  draft: AgentProfileDraft,
): AgentProfileDraftValidation {
  const parsed = agentProfileContentSchema.safeParse({
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    recommendedFor: draft.recommendedFor,
    tags: parseTags(draft.tagsText),
  });

  const errors: AgentProfileDraftErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field !== "string") continue;
      // First issue per field wins: the author fixes one thing at a time, and a
      // later issue on the same field is usually a consequence of the first.
      const key = field as keyof AgentProfileDraftErrors;
      errors[key] ??= issue.message;
    }
  }

  const collision = findReservedSequence(draft.instructions);
  if (collision !== null) {
    errors.instructions = `Instructions may not contain the reserved sequence ${JSON.stringify(collision.sequence)}.`;
  }

  if (!parsed.success) {
    // A schema failure always refuses, even if no issue carried a field path we
    // could attach it to — the form would otherwise offer to save a record the
    // server is about to reject.
    return {
      ok: false,
      errors:
        Object.keys(errors).length > 0
          ? errors
          : { name: "This profile is not valid." },
    };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, content: parsed.data };
}

export interface AgentProfilePreviewIdentity {
  tier: AgentProfileTier;
  id: string;
  /** The revision this draft would carry: the next one, or 1 for a create. */
  revision: number;
}

/**
 * The composed layer a draft would be delivered as, or null when it cannot
 * compose yet.
 *
 * Runs the real composer against a stub identity rather than approximating the
 * frame, so the preview cannot drift from what a backend receives. The stub is
 * necessary because a draft has no stored content hash — the preview shows the
 * bytes, and the composer's snapshot is what attests to them.
 */
export function previewAgentProfileBlock(
  draft: AgentProfileDraft,
  identity: AgentProfilePreviewIdentity,
): string | null {
  if (draft.instructions.length === 0 || draft.name.length === 0) return null;
  try {
    return renderProfileBlock({
      tier: identity.tier,
      id: identity.id,
      name: draft.name,
      revision: identity.revision,
      // Never read by the renderer; the format module takes the resolved shape
      // and only a snapshot's provenance depends on this field.
      sourceContentHash: `sha256:${"0".repeat(64)}`,
      instructions: draft.instructions,
    });
  } catch {
    // A colliding draft is already reported as a field error; the preview just
    // has nothing truthful to show for it.
    return null;
  }
}
