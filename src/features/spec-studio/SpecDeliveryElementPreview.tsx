"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import { specQueries } from "@/lib/specs/queries";
import type { SpecElementPayload } from "@/lib/specs/schemas";

export function deliveryElementTitle(payload: SpecElementPayload): string {
  if (payload.kind === "requirement") return payload.statement;
  if (payload.kind === "criterion") return payload.text;
  return payload.title;
}

export function deliveryElementText(payload: SpecElementPayload): string {
  switch (payload.kind) {
    case "requirement":
      return payload.statement;
    case "criterion":
      return `${payload.text}\n${payload.validationStrategy.note ?? ""}`;
    case "decision":
      return [
        payload.title,
        payload.chosenApproach,
        payload.reason,
        ...payload.rejectedAlternatives.flatMap((alternative) => [
          alternative.label,
          alternative.reason,
        ]),
      ].join("\n");
    case "section":
      return `${payload.title}\n${payload.body}`;
    case "task":
      return `${payload.title}\n${payload.instructions}`;
  }
}

export default function SpecDeliveryElementPreview({
  projectName,
  slug,
  handle,
  revisionId,
  revisionNumber,
  payload,
  kind,
  removed,
}: {
  projectName: string;
  slug: string;
  handle: string;
  revisionId: string;
  revisionNumber: number;
  payload: SpecElementPayload | undefined;
  kind: SpecElementPayload["kind"];
  removed: boolean;
}): React.JSX.Element {
  const query = useQuery({
    ...specQueries.element(projectName, slug, handle, undefined, revisionId),
    enabled: payload === undefined && kind !== "section",
  });
  const content =
    payload ??
    (query.data && "element" in query.data
      ? query.data.element.version.payload
      : undefined);
  const destination =
    kind === "requirement" || kind === "criterion"
      ? "Requirements"
      : kind === "decision"
        ? "Design"
        : kind === "task"
          ? "History"
          : "Overview";
  const baseHref = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
  const href = removed
    ? `${baseHref}?view=history&revision=${encodeURIComponent(revisionId)}`
    : kind === "section"
      ? baseHref
      : `${baseHref}?el=${encodeURIComponent(handle)}`;
  return (
    <div className="grid max-w-[1000px] min-w-0 gap-md font-mono text-[0.78rem] leading-relaxed [overflow-wrap:anywhere]">
      <p className="m-0 text-[0.7rem] text-text-tertiary">
        {removed ? "Removed from current scope · " : ""}Content from revision{" "}
        {revisionNumber}
      </p>
      {content ? (
        <PayloadContent payload={content} />
      ) : query.isFetching ? (
        <p role="status" className="m-0 text-text-secondary">
          Loading element content…
        </p>
      ) : (
        <div role="status" className="grid gap-sm">
          <p className="m-0 text-text-secondary">
            Content for this revision is unavailable.
          </p>
          {kind !== "section" && (
            <Button
              size="sm"
              touch
              layoutClassName="self-start"
              onClick={() => void query.refetch()}
            >
              Retry content
            </Button>
          )}
        </div>
      )}
      <Link
        href={href}
        className="inline-flex min-h-[32px] items-center justify-self-start rounded-sm font-semibold text-cyan no-underline hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
      >
        {removed ? "View revision history" : `Open current ${destination}`}
      </Link>
    </div>
  );
}

function PayloadContent({
  payload,
}: {
  payload: SpecElementPayload;
}): React.JSX.Element {
  if (payload.kind === "decision")
    return (
      <>
        <PreviewText label="Chosen approach" text={payload.chosenApproach} />
        <PreviewText label="Rationale" text={payload.reason} />
        {payload.rejectedAlternatives.length > 0 && (
          <div className="grid gap-sm">
            <span className="text-[0.7rem] font-semibold text-text-secondary uppercase">
              Alternatives considered
            </span>
            {payload.rejectedAlternatives.map((alternative, index) => (
              <div key={index}>
                <p className="m-0 font-semibold text-text-primary">
                  {alternative.label}
                </p>
                <CompactMarkdown content={alternative.reason} />
              </div>
            ))}
          </div>
        )}
      </>
    );
  if (payload.kind === "criterion")
    return (
      <>
        <CompactMarkdown content={payload.text} />
        <PreviewText
          label="Validation"
          text={
            payload.validationStrategy.note ??
            payload.validationStrategy.kinds.join(", ").replaceAll("_", " ")
          }
        />
      </>
    );
  if (payload.kind === "requirement")
    return (
      <>
        <CompactMarkdown content={payload.statement} />
        <p className="m-0 text-[0.7rem] text-text-secondary">
          Priority: {payload.priority} · Risk: {payload.risk}
        </p>
      </>
    );
  return (
    <CompactMarkdown
      content={payload.kind === "section" ? payload.body : payload.instructions}
    />
  );
}

function PreviewText({
  label,
  text,
}: {
  label: string;
  text: string;
}): React.JSX.Element {
  return (
    <div className="grid gap-xs">
      <span className="text-[0.7rem] font-semibold text-text-secondary uppercase">
        {label}
      </span>
      <CompactMarkdown content={text || "None recorded."} />
    </div>
  );
}
