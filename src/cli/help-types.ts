/**
 * Types for the `cctl` help registry — the single source of truth from which
 * per-command help text, `checkFlags` allowlists, the parse-time boolean-flag
 * set, and the top-level usage are all derived (docs/design/cc-cli/04 §2).
 *
 * This file sits at the bottom of the CLI import graph and imports NOTHING from
 * `shared.ts`: `shared.ts` → `help-registry.ts` → `*.help.ts` → `help-types.ts`.
 * The acyclicity is load-bearing — it is what lets the boolean-flag set derive
 * from the registry without a cycle back through the parser.
 */

/** One command-specific flag (global flags are implied, never declared here). */
export interface FlagSpec {
  /** Flag name without the leading "--". */
  name: string;
  kind: "value" | "boolean";
  /** e.g. "<path>"; value kind only. */
  valuePlaceholder?: string;
  /** One line. */
  description: string;
  /** e.g. `ask --option` may repeat. */
  repeatable?: boolean;
}

export interface HelpExample {
  /** Full command line including `cctl`. */
  invocation: string;
  /** One line: what it does / when to use it. */
  explanation: string;
}

/** A lateral graph edge to a related command. */
export interface RelatedRef {
  /** Space-joined path, e.g. "workflow start". */
  command: string;
  oneLiner: string;
}

/** An outbound graph edge to a skill ("load X when Y"). */
export interface SkillRef {
  /** Skill invocation name, e.g. "graph-workflow-planning". */
  name: string;
  /** One line, e.g. "before authoring plan.json". */
  loadWhen: string;
  /** Repo-relative SKILL.md path — contract-tested to exist on disk. */
  path: string;
}

export interface GeneratedReferenceSection {
  /** Heading for one registry-derived mechanical reference. */
  title: string;
  /** Pre-rendered rows derived from the owning typed registry. */
  lines: readonly string[];
}

export interface CommandHelpEntry {
  /** e.g. ["workflow","create"]; length ≥ 1; a length-1 node may be a group. */
  path: string[];
  /** One line — feeds the parent index + the top-level usage. */
  summary: string;
  /** 1–4 lines. */
  description: string;
  /** Invocation shapes. */
  usage: string[];
  /** Command-specific flags only (global flags are implied). */
  flags: FlagSpec[];
  /** ≥ 1 for leaf nodes; may be empty for group nodes. */
  examples: HelpExample[];
  /** ≤ 4 lines of CC domain-model context, only when it earns its place. */
  domainContext?: string;
  /** Lateral graph edges. */
  related: RelatedRef[];
  /** Outbound graph edges. */
  skills?: SkillRef[];
  /** Mechanical reference rows generated from production registries. */
  generatedReference?: readonly GeneratedReferenceSection[];
  /** Whether this command appears in the portable generated command reference. */
  includeInGeneratedReference?: boolean;
  /** Whether `--help` queries /api/agent/help-context (docs/design/cc-cli/04 §4). */
  dynamicContext?: boolean;
}

/** The registry map key for a command path: its segments joined by a space. */
export function pathKey(path: string[]): string {
  return path.join(" ");
}
