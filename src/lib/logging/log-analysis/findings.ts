import type { LogAnalysisFinding, LogAnalysisSeverity } from "./types";

const SEVERITY_RANK: Record<LogAnalysisSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function firstNumericEvidence(finding: LogAnalysisFinding): number {
  for (const evidence of finding.evidence) {
    if (typeof evidence.value === "number") return evidence.value;
  }
  return 0;
}

export function sortFindings(
  findings: readonly LogAnalysisFinding[],
): LogAnalysisFinding[] {
  return [...findings].sort((a, b) => {
    const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDelta !== 0) return severityDelta;
    const confidenceDelta = b.confidence - a.confidence;
    if (confidenceDelta !== 0) return confidenceDelta;
    return firstNumericEvidence(b) - firstNumericEvidence(a);
  });
}

export function capFindings(
  findings: readonly LogAnalysisFinding[],
  top: number,
): LogAnalysisFinding[] {
  return sortFindings(findings).slice(0, top);
}
