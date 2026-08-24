/**
 * The prefixes an agent reads as guidance, and nothing else
 * (`.kiro/steering/cli.md`, docs/design/cc-cli/09 §3). Each one is a promise
 * about what the line costs the reader: an `instruction:` is obeyed before
 * anything else, a `hint:` may be ignored. A seventh spelling does not add a
 * meaning — it makes the other six ambiguous, because an agent now has to
 * guess which tier an unfamiliar word belongs to.
 *
 * A `label: value` line inside a command's own output is not guidance: it is
 * primary output or detail (`artifact:`, `session:`, `history:`), and it is
 * read as data because it sits inside the body, not after it.
 *
 * Must not import anything: `help-render.ts` and `shared.ts` both compose it,
 * and they sit on opposite sides of the registry's import graph.
 */

export const GUIDANCE_PREFIXES = {
  /** Load-bearing do-now text; obeyed first, and it suppresses any hint. */
  instruction: "instruction",
  /** An invariant to keep true while the work continues. */
  reminder: "reminder",
  /** One advisory next step, safe to ignore, always a single line. */
  hint: "hint",
  /** The drill-down that reveals what a bounded read left out. */
  next: "next",
  /** Server-rendered help garnish, appended to a help page. */
  context: "context",
  /**
   * Why a refusal's constraint exists. Refusal output only — it costs the
   * reader nothing to act on, so a success path that printed one would be
   * asking the reader to weigh a reason for something that already happened.
   */
  why: "why",
} as const;

export type GuidancePrefix = keyof typeof GUIDANCE_PREFIXES;

/** One rendered guidance line. The tier is a vocabulary member, not a string. */
export function guidanceLine(prefix: GuidancePrefix, text: string): string {
  return `${GUIDANCE_PREFIXES[prefix]}: ${text}`;
}
