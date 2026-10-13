import type { RunBoundary, RunHaltClearedBy, RunRecord } from "./schemas";

/**
 * The occurrence of a boundary a Context's progress asks for (an approval or
 * a halt): it no longer asks once the Context's progress occurrence moves on.
 */
export function contextBoundaryOccurrence(
  contextId: string,
  progressOccurrence: string,
): string {
  return `${contextId}:${progressOccurrence}`;
}

/** What the owner needs beyond the boundary record to act without another read. */
export interface BoundaryNoticeExtras {
  questionText?: string;
}

/** How the owner clears a halt that only a definition change or cancelling ends. */
function definitionRemedy(
  id: string,
  clearedBy: Exclude<RunHaltClearedBy, "retry_lane">,
): string {
  return clearedBy === "cancel"
    ? `Resuming does not clear it, and a started loop's exit condition cannot be amended, so the remedy is to cancel the run and relaunch a corrected workflow: cctl run cancel ${id}`
    : `Resuming does not clear it. Amend the definition: cctl run definition ${id} writes it to a file and names the file and its revision; copy that file, in the copy change the routes of the result that halted or raise the loop's maxPasses, then cctl run amend ${id} --file <copy> --based-on <revision>. Or stop: cctl run cancel ${id}`;
}

function actionLine(
  run: Pick<RunRecord, "runId">,
  boundary: RunBoundary,
): string {
  const id = run.runId;
  const { detail } = boundary;
  switch (detail.kind) {
    case "question":
      return `Answer: cctl run answer ${id} --question ${detail.questionId} --text "<answer>"`;
    case "approval":
      return `Only Alex can decide this; agents cannot approve it. Tell Alex that run ${id}, context ${detail.contextId}, candidate ${detail.candidateId} awaits approval.`;
    case "context_halt":
      return [
        `Inspect: cctl run show ${id}.`,
        `Resume with one of (${detail.dispositions.length > 0 ? detail.dispositions.join(", ") : "see cctl run show"}): cctl run resume ${id} --context ${detail.contextId} --occurrence ${detail.occurrence} --disposition <kind>`,
      ].join(" ");
    case "run_halt": {
      if (detail.clearedBy === "retry_lane") {
        const retry = `Fix what stopped it, then ask for a new attempt: cctl run retry ${id} --lane ${detail.lane ?? "<lane>"}`;
        return detail.otherWorkRemains
          ? `Inspect: cctl run show ${id}. Work that does not need this lane continues. ${retry}`
          : `Inspect: cctl run show ${id}. ${retry}`;
      }
      const remedy = definitionRemedy(id, detail.clearedBy);
      return detail.otherWorkRemains
        ? `Inspect: cctl run show ${id}. Other work in this run is not finished; another notice follows once only halted routes or loops remain. ${remedy}`
        : `Inspect: cctl run show ${id}. ${remedy}`;
    }
    case "stalled":
      return `Inspect: cctl run show ${id}. ${definitionRemedy(id, detail.clearedBy)}`;
    case "fault":
      return `Inspect: cctl run show ${id}. Retry: cctl run resume ${id}`;
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
  if (boundary.detail.kind === "succeeded")
    lines.push(`Result: ${JSON.stringify(boundary.detail.outputs)}`);
  lines.push(actionLine(run, boundary), "</run-boundary>");
  return lines.join("\n");
}
