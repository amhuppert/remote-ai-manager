import type { LintFinding, LintSeverity } from "./lint";

/**
 * Severities in the order the acts they gate come up: propose first, then the
 * two later refusals, then the findings that refuse nothing. Every surface
 * that ranks findings ranks them this way, so the top of one panel is the top
 * of every other.
 */
export const LINT_SEVERITY_ORDER = [
  "blocks_propose",
  "blocks_claim",
  "blocks_signoff",
  "advisory",
] as const satisfies readonly LintSeverity[];

export const LINT_SEVERITY_LABEL: Record<LintSeverity, string> = {
  blocks_propose: "Blocks propose",
  blocks_claim: "Blocks claim",
  blocks_signoff: "Blocks sign-off",
  advisory: "Advisory",
};

/** How many findings a summary tier names before pointing at the full panel. */
export const DRAFT_HEALTH_TOP_FINDINGS = 5;

export interface DraftHealthCount {
  readonly severity: LintSeverity;
  readonly count: number;
}

export interface DraftHealthGroup {
  readonly severity: LintSeverity;
  readonly findings: readonly LintFinding[];
}

export interface DraftHealth {
  readonly total: number;
  /** Findings that refuse propose outright — the count a receipt reports. */
  readonly blocking: number;
  readonly counts: readonly DraftHealthCount[];
  readonly groups: readonly DraftHealthGroup[];
  readonly blockingFindings: readonly LintFinding[];
  /** Every finding, severity-ranked; the first N are a summary's top N. */
  readonly ordered: readonly LintFinding[];
}

/**
 * The one reading of a lint result every surface shares: the CLI `spec lint`
 * panel, the `spec status` findings tier, the blocking-count delta on a draft
 * receipt, the propose refusal, and Spec Studio's lint tab. Grouping, ranking,
 * and what counts as blocking are decided here once, so two surfaces cannot
 * disagree about whether a draft is proposable.
 *
 * `lint()` already returns a total order (rule, then handle, then message);
 * this only re-ranks it by severity and preserves that order within each
 * group, which is what makes a top-5 stable across runs.
 */
export function draftHealth(findings: readonly LintFinding[]): DraftHealth {
  const groups: DraftHealthGroup[] = [];
  for (const severity of LINT_SEVERITY_ORDER) {
    const matching = findings.filter(
      (finding) => finding.severity === severity,
    );
    if (matching.length === 0) continue;
    groups.push({ severity, findings: matching });
  }
  const ordered = groups.flatMap((group) => group.findings);
  const blockingFindings =
    groups.find((group) => group.severity === "blocks_propose")?.findings ?? [];
  return {
    total: findings.length,
    blocking: blockingFindings.length,
    counts: groups.map((group) => ({
      severity: group.severity,
      count: group.findings.length,
    })),
    groups,
    blockingFindings,
    ordered,
  };
}
