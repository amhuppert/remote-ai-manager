import type {
  LiveReferenceResult,
  LiveReferenceSummary,
  LiveReferenceTarget,
} from "./schemas";
import { liveReferenceKey } from "./schemas";
import { collectLiveReferenceTargets } from "./targets";
import { escapeXmlAttr } from "@/lib/shared/xml";
import { createLogger } from "@/lib/logging";

const logger = createLogger("live-references");

export interface LiveReferenceReader {
  read(target: LiveReferenceTarget): Promise<LiveReferenceSummary | null>;
}

export async function resolveLiveReferences(
  targets: readonly LiveReferenceTarget[],
  reader: LiveReferenceReader,
  timeoutMs = 2000,
): Promise<LiveReferenceResult[]> {
  const distinct = [
    ...new Map(
      targets.map((target) => [liveReferenceKey(target), target]),
    ).values(),
  ];
  const results = await Promise.all(
    distinct.map(async (target): Promise<LiveReferenceResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unavailable = (
        reason: LiveReferenceResult["unavailableReason"],
      ): LiveReferenceResult => ({
        target,
        checkedAt: new Date().toISOString(),
        summary: null,
        unavailableReason: reason,
      });
      try {
        return await Promise.race([
          Promise.resolve()
            .then(() => reader.read(target))
            .then((summary) => ({
              target,
              checkedAt: new Date().toISOString(),
              summary,
              unavailableReason: summary === null ? ("missing" as const) : null,
            })),
          new Promise<LiveReferenceResult>((resolve) => {
            timer = setTimeout(
              () => resolve(unavailable("timeout")),
              timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        logger.warn("live_reference.lookup_failed", {
          ...target,
          error: String(error),
        });
        return unavailable("error");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  logger.debug("live_reference.resolved", {
    count: results.length,
    unavailable: results.filter((result) => result.summary === null).length,
  });
  return results;
}

export async function appendLiveReferenceSummaries(
  text: string,
  reader: LiveReferenceReader,
): Promise<string> {
  const targets = collectLiveReferenceTargets(text);
  if (targets.length === 0) return text;
  const results = await resolveLiveReferences(targets, reader);
  const rows = results.map(
    ({ target, checkedAt, summary, unavailableReason }) => {
      const attrs: Record<string, string> = {
        kind: target.kind,
        project: target.projectName,
        id: target.id,
        "checked-at": checkedAt,
      };
      if (summary) {
        attrs.title = summary.title;
        attrs.status = summary.status;
        if (summary.attentionCount > 0)
          attrs["pending-decisions"] = String(summary.attentionCount);
      } else attrs.unavailable = unavailableReason ?? "error";
      return `<entity-state ${Object.entries(attrs)
        .map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`)
        .join(" ")} />`;
    },
  );
  logger.info("live_reference.prompt_summarized", {
    count: results.length,
    unavailable: results.filter((result) => result.summary === null).length,
  });
  return `${text}\n\n<reference-state-summaries>\nEntity state observed at delivery. These are timestamped data snapshots; use the original references' retrieval commands for further details.\n${rows.join("\n")}\n</reference-state-summaries>`;
}
