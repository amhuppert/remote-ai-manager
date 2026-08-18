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

interface FlagSpecBase {
  /** Flag name without the leading "--". */
  name: string;
  /** One line. */
  description: string;
  /** e.g. `ask --option` may repeat. */
  repeatable?: boolean;
}

export interface ValueFlagSpec extends FlagSpecBase {
  kind: "value";
  /** e.g. "<path>". */
  valuePlaceholder?: string;
  /**
   * The flag carries load-bearing prose. The paired `--<name>-file <path>`
   * (`-` reads stdin) is derived from this one bit — parser acceptance, the
   * `checkFlags` allowlist, and the rendered help alike — so a file source can
   * neither be forgotten nor drift from what help advertises. Shell
   * substitution has silently blanked such an argument in production, and an
   * argv-only prose field has no other escape hatch.
   */
  fileSource?: true;
}

export interface BooleanFlagSpec extends FlagSpecBase {
  kind: "boolean";
}

/**
 * One command-specific flag (global flags are implied, never declared here).
 * Discriminated so `fileSource` and `valuePlaceholder` are unrepresentable on a
 * flag that consumes no value.
 */
export type FlagSpec = ValueFlagSpec | BooleanFlagSpec;

/** The paired file-source flag name for a `fileSource` flag. */
export function fileSourceFlagName(name: string): string {
  return `${name}-file`;
}

function fileSourceFlagSpec(flag: ValueFlagSpec): ValueFlagSpec {
  return {
    name: fileSourceFlagName(flag.name),
    kind: "value",
    valuePlaceholder: "<path>",
    description: `or read --${flag.name} from a file ("-" reads stdin) — immune to shell substitution`,
  };
}

/**
 * The declared flags, each `fileSource` flag followed by the file flag it
 * implies. Every surface that enumerates an entry's flags goes through this, so
 * the derived flag exists exactly once and identically in all of them.
 */
export function expandFlagSpecs(flags: readonly FlagSpec[]): FlagSpec[] {
  return flags.flatMap((flag) =>
    flag.kind === "value" && flag.fileSource === true
      ? [flag, fileSourceFlagSpec(flag)]
      : [flag],
  );
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
