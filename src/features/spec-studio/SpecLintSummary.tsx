"use client";

import { useState } from "react";
import Link from "next/link";

import { StatusChip } from "@/components/ui/StatusChip";
import { draftHealth, LINT_SEVERITY_LABEL } from "@/lib/specs/draft-health";
import type { LintFinding } from "@/lib/specs/lint";

export default function SpecLintSummary({
  projectName,
  slug,
  findings,
  isPending,
  error,
}: {
  projectName: string;
  slug: string;
  findings: LintFinding[];
  isPending: boolean;
  error: string | null;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (!isPending && error === null && findings.length === 0) return null;
  const health = draftHealth(findings);

  return (
    <section
      aria-label="Lint summary"
      className="mx-auto mt-lg max-w-[1000px] rounded-md border border-solid border-border-subtle bg-bg-surface p-md"
    >
      {isPending ? (
        <p
          role="status"
          className="m-0 font-mono text-[0.7rem] text-text-tertiary"
        >
          Running lint…
        </p>
      ) : error !== null ? (
        <p role="alert" className="m-0 font-mono text-[0.7rem] text-red">
          {error}
        </p>
      ) : (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full cursor-pointer items-center justify-between gap-md border-0 bg-transparent p-0 text-left font-mono text-[0.72rem] text-text-primary"
          >
            <span>
              {findings.length} lint{" "}
              {findings.length === 1 ? "finding" : "findings"}
              {health.blocking > 0 ? ` · ${health.blocking} blocking` : ""}
            </span>
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
          {expanded && (
            <ul className="mt-md mb-0 grid list-none gap-sm p-0">
              {findings.map((finding, index) => (
                <li
                  key={`${finding.ruleId}-${finding.elementHandle}-${index}`}
                  className="flex flex-wrap items-start gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim pt-sm"
                >
                  <StatusChip
                    tone={finding.severity === "advisory" ? "amber" : "red"}
                  >
                    {LINT_SEVERITY_LABEL[finding.severity]}
                  </StatusChip>
                  <span className="min-w-0 flex-1 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
                    {finding.message}
                  </span>
                  {finding.elementHandle.length > 0 && (
                    <Link
                      href={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?el=${encodeURIComponent(finding.elementHandle)}`}
                      className="font-mono text-[0.7rem] font-semibold text-cyan no-underline hover:text-cyan-dim"
                    >
                      {finding.elementHandle}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
