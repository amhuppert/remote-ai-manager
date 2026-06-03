import { spawnProposalSchema, type SpawnProposal } from "./schemas";

/**
 * The info string of the fenced code block an agent uses to mark a spawn
 * proposal in its turn text (```spawn-proposal ... ```). The exact emission
 * convention is the foundation's system-prompt concern; `extractProposal`
 * accepts either a pre-parsed candidate object or this fenced block so the
 * validator stays agnostic to how the marker is produced.
 */
export const SPAWN_PROPOSAL_FENCE = "spawn-proposal";

/**
 * Result of validating an agent-emitted proposal candidate. `valid` carries the
 * parsed, defaults-applied proposal ready to drive creation; `invalid` carries
 * human-readable issue strings to surface in the card / route 400.
 */
export type ProposalValidation =
  | { kind: "valid"; proposal: SpawnProposal }
  | { kind: "invalid"; issues: string[] };

/**
 * Validate an untrusted candidate against `spawnProposalSchema` via `safeParse`
 * (agent output is untrusted). Pure: never throws, never mutates the input.
 */
export function validateProposal(candidate: unknown): ProposalValidation {
  const result = spawnProposalSchema.safeParse(candidate);
  if (result.success) {
    return { kind: "valid", proposal: result.data };
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return { kind: "invalid", issues };
}

function isCandidateObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull a `spawn-proposal` fenced JSON block out of agent turn text. Returns the
 * parsed object, or null when no well-formed block is present. Never throws.
 */
function extractFromText(text: string): unknown | null {
  const fence = new RegExp(
    "```" + SPAWN_PROPOSAL_FENCE + "\\s*\\n([\\s\\S]*?)\\n```",
  );
  const match = fence.exec(text);
  if (match === null) return null;
  try {
    return JSON.parse(match[1]!) as unknown;
  } catch {
    return null;
  }
}

/**
 * Extract a candidate proposal object from an agent turn's structured output.
 * Accepts either an already-parsed object carrying a `sessions` key or a string
 * containing a ```spawn-proposal fenced JSON block. Returns `null` when the turn
 * contains no proposal (the card is not rendered). Never throws, never mutates.
 */
export function extractProposal(turnOutput: unknown): unknown | null {
  if (isCandidateObject(turnOutput)) {
    return "sessions" in turnOutput ? turnOutput : null;
  }
  if (typeof turnOutput === "string") {
    return extractFromText(turnOutput);
  }
  return null;
}
