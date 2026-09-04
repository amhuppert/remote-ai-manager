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
  /**
   * Preserve an explicitly empty inline value for command-specific semantics.
   * This is intentionally rare: most empty flag values are an argv mistake.
   */
  allowEmpty?: true;
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

/**
 * One success hint that walks a receipt to its successor (#80 design 3.6): the
 * launch sequence is authored beside the command it follows, never copied into
 * prose, so a renamed verb breaks the registry sweep rather than an agent's
 * next command.
 *
 * A row is data plus its own renderer because the text carries runtime tokens
 * (an id, a slug, a file path) that only the receipt holds. `sample()` renders
 * it with stand-in tokens, which is what lets a sweep read every row without
 * knowing any of their token shapes.
 */
export interface SuccessHintRow {
  /** The receipt this row closes, e.g. "spec start". */
  readonly after: string;
  /** The command path the hint names; resolved against the registry. */
  readonly names: readonly string[];
  /** The row rendered with placeholder tokens, for the contract sweep. */
  sample(): string;
}

/**
 * Declare one success-hint row. The tokens type is inferred from `sampleTokens`,
 * so a receipt cannot render a row with the wrong token set and a row cannot
 * carry a sample its own renderer would reject.
 */
export function successHintRow<TTokens>(spec: {
  readonly after: string;
  readonly names: readonly string[];
  readonly sampleTokens: TTokens;
  readonly hint: (tokens: TTokens) => string;
}): SuccessHintRow & { hint: (tokens: TTokens) => string } {
  return {
    after: spec.after,
    names: spec.names,
    hint: spec.hint,
    sample: () => spec.hint(spec.sampleTokens),
  };
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
  /** The success hints this command's receipts render (#80 design 3.6). */
  successHints?: readonly SuccessHintRow[];
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
