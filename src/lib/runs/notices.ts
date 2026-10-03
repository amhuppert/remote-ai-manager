import { DISPOSITIONS_BY_HALT } from "@/lib/execution-context/advance";
import { haltKindSchema } from "@/lib/execution-context/schemas";
import { boundaryDetail, type RunBoundary, type RunRecord } from "./schemas";

/** What the owner needs beyond the boundary record to act without another read. */
export interface BoundaryNoticeExtras {
  questionText?: string;
}

function dispositionsFor(halt: unknown): ReadonlyArray<string> {
  const parsed = haltKindSchema.safeParse(halt);
  return parsed.success ? DISPOSITIONS_BY_HALT[parsed.data] : ["see cctl run show"];
}

function actionLine(run: Pick<RunRecord, "runId">, boundary: RunBoundary): string {
  const id = run.runId;
  const detail = boundaryDetail(boundary);
  switch (boundary.kind) {
    case "question":
      return `Answer: cctl run answer ${id} --question ${String(detail.questionId)} --text "<answer>"`;
    case "approval":
      return `Only Alex can decide this; agents cannot approve it. Tell Alex that run ${id}, context ${String(detail.contextId)}, candidate ${String(detail.candidateId)} awaits approval.`;
    case "halted":
      // A run-level halt (its own reconcile failed) clears with a plain resume.
      if (typeof detail.contextId !== "string" || typeof detail.occurrence !== "string") {
        return `Inspect: cctl run show ${id}. Retry: cctl run resume ${id}`;
      }
      return [
        `Inspect: cctl run show ${id}.`,
        `Resume with one of (${dispositionsFor(detail.halt).join(", ")}): cctl run resume ${id} --context ${detail.contextId} --occurrence ${detail.occurrence} --disposition <kind>`,
      ].join(" ");
    case "restored_paused":
      return `Inspect: cctl run show ${id}. Continue: cctl run resume ${id}. Stop: cctl run cancel ${id}`;
    case "succeeded":
    case "cancelled":
      return `Details: cctl run show ${id}`;
  }
}

/** The message an owner conversation receives for one Run boundary. */
export function composeBoundaryNotice(
  run: Pick<RunRecord, "runId">,
  boundary: RunBoundary,
  extras: BoundaryNoticeExtras = {},
): string {
  const lines = [
    `<run-boundary run="${run.runId}" kind="${boundary.kind}" boundary="${boundary.seq}">`,
    boundary.summary,
  ];
  if (extras.questionText !== undefined) lines.push(`Question: ${extras.questionText}`);
  if (boundary.kind === "succeeded") {
    lines.push(`Result: ${JSON.stringify(boundaryDetail(boundary).outputs ?? null)}`);
  }
  lines.push(actionLine(run, boundary), "</run-boundary>");
  return lines.join("\n");
}
