import { z } from "zod";
import { boundaryDetail, type RunBoundary, type RunRecord } from "./schemas";

/** What the owner needs beyond the boundary record to act without another read. */
export interface BoundaryNoticeExtras {
  questionText?: string;
}

/** The dispositions the Context named for its halt when the boundary was recorded. */
function dispositionsFor(detail: Record<string, unknown>): ReadonlyArray<string> {
  const parsed = z.array(z.string()).min(1).safeParse(detail.dispositions);
  return parsed.success ? parsed.data : ["see cctl run show"];
}

function actionLine(
  run: Pick<RunRecord, "runId">,
  boundary: RunBoundary,
): string {
  const id = run.runId;
  const detail = boundaryDetail(boundary);
  switch (boundary.kind) {
    case "question":
      return `Answer: cctl run answer ${id} --question ${String(detail.questionId)} --text "<answer>"`;
    case "approval":
      return `Only Alex can decide this; agents cannot approve it. Tell Alex that run ${id}, context ${String(detail.contextId)}, candidate ${String(detail.candidateId)} awaits approval.`;
    case "halted":
      // A lane halt clears with a new attempt once its cause is fixed.
      if (typeof detail.runHalt === "string" && typeof detail.lane === "string") {
        const retry = `Fix what stopped it, then ask for a new attempt: cctl run retry ${id} --lane ${detail.lane}`;
        return detail.otherWorkRemains === true
          ? `Inspect: cctl run show ${id}. Work that does not need this lane continues. ${retry}`
          : `Inspect: cctl run show ${id}. ${retry}`;
      }
      // Only a definition change clears a route or loop halt, and the Run has
      // no amend operation, so stopping the run is the only remedy.
      if (typeof detail.runHalt === "string") {
        const remedy = `Resuming does not clear it and the definition cannot be amended, so the remedy is to cancel the run and relaunch a corrected workflow: cctl run cancel ${id}`;
        return detail.otherWorkRemains === true
          ? `Inspect: cctl run show ${id}. Other work in this run is not finished; another notice follows once only halted routes or loops remain. ${remedy}`
          : `Inspect: cctl run show ${id}. ${remedy}`;
      }
      // A run-level halt (its own reconcile failed) clears with a plain resume.
      if (
        typeof detail.contextId !== "string" ||
        typeof detail.occurrence !== "string"
      ) {
        return `Inspect: cctl run show ${id}. Retry: cctl run resume ${id}`;
      }
      return [
        `Inspect: cctl run show ${id}.`,
        `Resume with one of (${dispositionsFor(detail).join(", ")}): cctl run resume ${id} --context ${detail.contextId} --occurrence ${detail.occurrence} --disposition <kind>`,
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
  if (extras.questionText !== undefined)
    lines.push(`Question: ${extras.questionText}`);
  if (boundary.kind === "succeeded") {
    lines.push(
      `Result: ${JSON.stringify(boundaryDetail(boundary).outputs ?? null)}`,
    );
  }
  lines.push(actionLine(run, boundary), "</run-boundary>");
  return lines.join("\n");
}
