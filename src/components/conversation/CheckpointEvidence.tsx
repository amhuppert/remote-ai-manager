"use client";

import { useState } from "react";

import { ArchiveIcon, ChatIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { useCheckpointSeedQuery } from "@/lib/conversation-checkpoints/queries";
import type { CheckpointTarget } from "@/lib/conversation-checkpoints/query-keys";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import {
  conversationReadUrl,
  historyEntryUrl,
  historyImageUrl,
  useConversationRead,
  useHistoryEntry,
  useHistoryEntryMetadata,
  useHistoryImage,
} from "@/lib/conversations/history-queries";
import type { HistoryImageHandle } from "@/lib/conversations/history-recovery";

import CheckpointDisclosure from "./CheckpointDisclosure";
import CheckpointHandoffAudit from "./CheckpointHandoffAudit";

export interface CheckpointEvidenceProps {
  target: CheckpointTarget;
  receipt: CheckpointReceipt;
  /**
   * The boundary of the checkpoint before this one. The archive window this
   * checkpoint closed starts just after it; absent means the conversation's
   * beginning.
   */
  previousBoundarySeq?: number | null;
  /**
   * Scrolls the host transcript to a merged message index. Absent on a host
   * with no transcript navigation, which leaves the coordinates readable and
   * the export links usable.
   */
  onNavigateToMessage?: (messageIndex: number) => void;
  /**
   * The conversation's rolling reading artifact, when it has one. Its coverage
   * is compared against the saved boundary so neither view silently stands in
   * for the other.
   */
  artifact?: { coveredEndSeq: number; updatedAt: string } | null;
}

const LABEL_CLASS =
  "font-mono text-[0.7rem] font-medium tracking-[0.1em] text-text-secondary uppercase";
const ROW_CLASS =
  "flex flex-wrap items-center gap-x-sm gap-y-xs font-mono text-[0.72rem] leading-[1.6] text-text-secondary [overflow-wrap:anywhere]";
const LINK_CLASS =
  "inline-flex min-h-[32px] items-center gap-xs rounded-sm px-xs py-xs font-mono text-[0.72rem] text-cyan underline-offset-4 hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";
const BODY_CLASS =
  "m-0 max-h-[320px] overflow-auto rounded-md border border-solid border-border-subtle bg-bg-surface p-md font-mono text-[0.78rem] leading-[1.7] whitespace-pre-wrap text-text-primary [overflow-wrap:anywhere]";

/**
 * One image handle, recovered through the scoped endpoint and shown in place.
 *
 * The handle's coordinates are the ORIGINAL ones — the CC-frame sequence and
 * the image-bearing content-block index, exactly as the CLI addresses them —
 * so what renders here is the same bytes `cctl conversation image get` returns.
 */
function EvidenceImage({
  target,
  handle,
}: {
  target: CheckpointTarget;
  handle: HistoryImageHandle;
}): React.JSX.Element {
  const { data, isError } = useHistoryImage(
    target,
    handle.seq,
    handle.contentBlockIndex,
  );
  const label = `Image at block ${handle.contentBlockIndex} (${handle.mediaType})`;
  const href = historyImageUrl(target, handle.seq, handle.contentBlockIndex);
  if (isError) {
    return (
      <a className={LINK_CLASS} href={href} target="_blank" rel="noreferrer">
        {`${label} — open directly`}
      </a>
    );
  }
  return (
    <a
      className={LINK_CLASS}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={handle.command}
    >
      {data === undefined ? (
        <span>{`${label} — reading…`}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- archive bytes
        // arrive as a data URL from the scoped endpoint, not a static asset
        // the image optimizer can address.
        <img
          src={data}
          alt={label}
          className="max-h-[96px] max-w-[128px] rounded-sm"
        />
      )}
    </a>
  );
}

/**
 * One archive entry: its measurements, its complete export, and its images.
 *
 * Used for the checkpoint's own boundary and for any entry reached from the
 * range outline, so an entry indexed from the middle of the window is as
 * readable as the boundary that closed it. The complete body is fetched only
 * while it is open — opening a receipt pulls no entry text into the cache.
 */
function EntryEvidence({
  target,
  seq,
  open,
  onToggle,
}: {
  target: CheckpointTarget;
  seq: number;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const metadataQuery = useHistoryEntryMetadata(target, seq);
  const entry = metadataQuery.data?.entry ?? null;
  const completeQuery = useHistoryEntry(target, seq, { enabled: open });

  return (
    <div
      className="flex min-w-0 flex-col gap-sm"
      data-checkpoint-entry-seq={seq}
    >
      <p className={ROW_CLASS}>
        {/* Opening it in place keeps the reader in the conversation the
            evidence belongs to; the raw export stays one link away for
            anything a panel cannot usefully render. */}
        <Button
          touch
          size="sm"
          variant="default"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open
            ? `Hide complete entry at seq ${seq}`
            : `Open complete entry at seq ${seq}`}
        </Button>
        <a
          className={LINK_CLASS}
          href={historyEntryUrl(target, seq)}
          target="_blank"
          rel="noreferrer"
        >
          Raw export for seq {seq}
        </a>
      </p>
      {entry !== null && (
        <p className={ROW_CLASS}>
          {entry.bytes} bytes · sha256 {entry.sha256}
        </p>
      )}
      {open && (
        <div data-checkpoint-entry="">
          {completeQuery.isLoading && (
            <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
              Reading the complete entry…
            </p>
          )}
          {completeQuery.data !== undefined && (
            // The full normalized body, with no presentation excerpt applied:
            // a truncated tool result is not the evidence.
            <pre className={BODY_CLASS}>{completeQuery.data.text}</pre>
          )}
          {completeQuery.isError && (
            <p className="m-0 font-mono text-[0.72rem] text-amber">
              The complete entry could not be read; the raw export link above
              still addresses it.
            </p>
          )}
        </div>
      )}
      {entry !== null && entry.images.length > 0 && (
        <div className={ROW_CLASS} data-checkpoint-images="">
          <span className={LABEL_CLASS}>Images</span>
          {entry.images.map((handle) => (
            <EvidenceImage
              key={`${handle.seq}:${handle.contentBlockIndex}`}
              target={target}
              handle={handle}
            />
          ))}
        </div>
      )}
      {metadataQuery.isError && (
        <p className="m-0 font-mono text-[0.72rem] text-amber">
          The archive entry at raw seq {seq} could not be read; the coordinate
          is still the evidence.
        </p>
      )}
    </div>
  );
}

/**
 * The archive window this checkpoint closed, indexed through the scoped read
 * route.
 *
 * A boundary is one coordinate; the evidence a reader actually wants is the
 * range behind it. `outline=true` keeps each logical message to a single
 * headline, so indexing even a long window costs one bounded read, and every
 * row is a route to that entry's own complete export and images.
 */
function ArchiveRange({
  target,
  fromSeq,
  toSeq,
  onOpenEntry,
  onNavigateToMessage,
  defaultShown = false,
}: {
  target: CheckpointTarget;
  fromSeq: number;
  toSeq: number;
  onOpenEntry: (seq: number) => void;
  onNavigateToMessage?: (messageIndex: number) => void;
  /** A continuation opens already expanded — the reader just asked for it. */
  defaultShown?: boolean;
}): React.JSX.Element {
  const [shown, setShown] = useState(defaultShown);
  const [continuation, setContinuation] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const window = { outline: true, seqRange: [fromSeq, toSeq] as const };
  const readQuery = useConversationRead(target, window, { enabled: shown });
  const omittedAfter =
    readQuery.data?.truncated === true
      ? (readQuery.data.truncation.omittedAfter ?? null)
      : null;

  return (
    <section className="flex flex-col gap-2xs" data-checkpoint-archive="">
      <p className={ROW_CLASS}>
        <Button
          touch
          size="sm"
          variant="default"
          aria-expanded={shown}
          onClick={() => setShown((current) => !current)}
        >
          {shown
            ? `Hide archive outline for seq ${fromSeq}–${toSeq}`
            : `Show archive outline for seq ${fromSeq}–${toSeq}`}
        </Button>
        <a
          className={LINK_CLASS}
          href={conversationReadUrl(target, window)}
          target="_blank"
          rel="noreferrer"
        >
          Raw range read
        </a>
      </p>
      {shown && (
        <>
          {readQuery.isLoading && (
            <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
              Reading the archive outline…
            </p>
          )}
          {readQuery.isError && (
            <p className="m-0 font-mono text-[0.72rem] text-amber">
              The outline for seq {fromSeq}–{toSeq} could not be read; the raw
              range read above still addresses it.
            </p>
          )}
          {readQuery.data !== undefined && (
            <ul className="m-0 flex list-none flex-col gap-2xs p-0">
              {readQuery.data.units.map((unit) => {
                // One logical message can merge SEVERAL raw entries — prose in
                // one, a tool result or image in the next — while the export
                // endpoint serves one raw entry at a time. Offering only
                // `ref.seqStart` would therefore hide exactly the tool
                // evidence a reader opened the outline for. Clamping to the
                // window also matters: a unit straddling the range can start
                // before `fromSeq`, and that entry is not in this window.
                const inRange = unit.entrySeqs.filter(
                  (seq) => seq >= fromSeq && seq <= toSeq,
                );
                const primary = inRange[0] ?? unit.ref.seqStart;
                return (
                  <li key={`${unit.ref.seqStart}:${unit.ref.seqEnd}`}>
                    <span className={ROW_CLASS}>
                      <button
                        type="button"
                        className="min-h-[44px] min-w-0 flex-1 cursor-pointer rounded-sm border border-solid border-transparent bg-transparent px-sm py-sm text-left font-mono text-[0.78rem] text-text-primary hover:border-border-default hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]"
                        onClick={() => onOpenEntry(primary)}
                      >
                        <Badge tier="count">{`s${primary}`}</Badge>{" "}
                        {`${unit.role} · ${unit.lines[0] ?? "(no rendered text)"}`}
                      </button>
                      {onNavigateToMessage !== undefined && (
                        <Button
                          touch
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            onNavigateToMessage(unit.ref.messageIndex)
                          }
                        >
                          {`#${unit.ref.messageIndex}`}
                        </Button>
                      )}
                    </span>
                    {inRange.length > 1 && (
                      <span className={ROW_CLASS}>
                        {inRange.map((seq) => (
                          <Button
                            touch
                            key={seq}
                            size="sm"
                            variant="ghost"
                            aria-label={`Open complete entry at seq ${seq}`}
                            onClick={() => onOpenEntry(seq)}
                          >
                            {`s${seq}`}
                          </Button>
                        ))}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {/* A bounded read can stop before the end of the window it was
              asked for. Saying so and naming the rest is what keeps the
              omitted entries recoverable instead of silently absent. */}
          {omittedAfter !== null && continuation === null && (
            <p className={ROW_CLASS}>
              <span className="text-text-tertiary">
                {`${omittedAfter.unitCount} later message${
                  omittedAfter.unitCount === 1 ? "" : "s"
                } in this range were not reached by the outline.`}
              </span>
              <Button
                touch
                size="sm"
                variant="default"
                onClick={() =>
                  setContinuation({
                    from: omittedAfter.nextSeq,
                    to: omittedAfter.lastSeq,
                  })
                }
              >
                {`Show seq ${omittedAfter.nextSeq}–${omittedAfter.lastSeq}`}
              </Button>
            </p>
          )}
          {continuation !== null && (
            <ArchiveRange
              target={target}
              fromSeq={continuation.from}
              toSeq={continuation.to}
              onOpenEntry={onOpenEntry}
              defaultShown
              {...(onNavigateToMessage === undefined
                ? {}
                : { onNavigateToMessage })}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * Original evidence for one saved checkpoint (design §7).
 *
 * The archive is the authority, so the boundary is shown as the raw sequence
 * it was RECORDED as, and its merged message index is resolved against the
 * archive rather than inferred from the seed's own references — a guess would
 * drift the divider a little further with every repeated compaction.
 *
 * Everything here is a read: opening an entry, outlining the range, recovering
 * an image, or disclosing the saved handoff submits nothing and changes no
 * conversation's model context.
 */
export default function CheckpointEvidence({
  target: seedTarget,
  receipt,
  previousBoundarySeq: suppliedPreviousBoundary = null,
  onNavigateToMessage: suppliedNavigation,
  artifact: suppliedArtifact,
}: CheckpointEvidenceProps): React.JSX.Element {
  const target = receipt.forkOrigin?.evidenceSource ?? seedTarget;
  const previousBoundarySeq = receipt.forkOrigin
    ? null
    : suppliedPreviousBoundary;
  const onNavigateToMessage = receipt.forkOrigin
    ? undefined
    : suppliedNavigation;
  const artifact = receipt.forkOrigin ? null : suppliedArtifact;
  const [seedShown, setSeedShown] = useState(false);
  const [captureEntrySeq, setCaptureEntrySeq] = useState<number | null>(null);
  const coverage = receipt.handoff?.sourceCoverage;
  const boundarySeq = receipt.boundary.capturedThroughSeq;
  // Which entry's body is open. It follows the selected checkpoint by
  // defaulting to the boundary, and an outlined row moves it into the window.
  const [openEntrySeq, setOpenEntrySeq] = useState<number | null>(null);

  const boundaryEntryQuery = useHistoryEntryMetadata(target, boundarySeq);
  const boundaryEntry = boundaryEntryQuery.data?.entry ?? null;

  const seedQuery = useCheckpointSeedQuery(seedTarget, receipt.operationId, {
    enabled: seedShown,
  });

  const artifactIsNewer =
    artifact != null && artifact.coveredEndSeq > boundarySeq;
  const rangeFrom =
    previousBoundarySeq === null ? 0 : Math.max(0, previousBoundarySeq + 1);

  return (
    <section className="flex flex-col gap-sm" data-checkpoint-evidence="">
      <CheckpointHandoffAudit receipt={receipt}>
        {coverage && (
          <div className="flex min-w-0 flex-col gap-md">
            <p className={ROW_CLASS}>
              Original capture records — audit only. Opening records sends no
              model input.
            </p>
            <EntryEvidence
              target={target}
              seq={captureEntrySeq ?? coverage.seqStart}
              open={captureEntrySeq !== null}
              onToggle={() =>
                setCaptureEntrySeq((current) =>
                  current === null ? coverage.seqStart : null,
                )
              }
            />
            <ArchiveRange
              target={target}
              fromSeq={coverage.seqStart}
              toSeq={coverage.seqEnd}
              onOpenEntry={setCaptureEntrySeq}
            />
          </div>
        )}
      </CheckpointHandoffAudit>
      {receipt.checkpoint !== null && (
        <CheckpointDisclosure
          title="Saved handoff"
          description="The exact summary saved for fresh context"
          icon={<ChatIcon size={20} />}
          operationId={receipt.operationId}
          open={seedShown}
          onOpenChange={setSeedShown}
        >
          <div className="flex flex-col gap-md">
            {seedQuery.isLoading && (
              <p className="text-[0.78rem] text-text-secondary">
                Reading the saved handoff…
              </p>
            )}
            {(seedQuery.isError || seedQuery.data?.seed === null) && (
              <div className="flex flex-col items-start gap-md">
                <p
                  role="alert"
                  className="text-[0.78rem] leading-[1.6] text-amber"
                >
                  The saved handoff could not be read. The checkpoint is still
                  saved.
                </p>
                <Button
                  touch
                  size="sm"
                  onClick={() => void seedQuery.refetch()}
                  loading={seedQuery.isFetching}
                >
                  Retry handoff
                </Button>
              </div>
            )}
            {seedQuery.data?.seed != null && (
              // The exact frozen bytes, never a re-render of them: the seed
              // is the string the next turn actually received.
              <pre className={BODY_CLASS}>{seedQuery.data.seed.seedText}</pre>
            )}
          </div>
        </CheckpointDisclosure>
      )}

      <CheckpointDisclosure
        title="Original archive"
        description="Messages, tool results and images at this checkpoint"
        icon={<ArchiveIcon size={20} />}
        operationId={receipt.operationId}
      >
        <div className="flex min-w-0 flex-col gap-lg">
          <p className={ROW_CLASS} data-checkpoint-boundary="">
            <span>
              Derived boundary: captured through raw seq {boundarySeq}
            </span>
            {boundaryEntry !== null && (
              <span>· message #{boundaryEntry.messageIndex}</span>
            )}
            {boundaryEntry !== null && onNavigateToMessage !== undefined && (
              <Button
                touch
                size="sm"
                variant="ghost"
                onClick={() => onNavigateToMessage(boundaryEntry.messageIndex)}
              >
                {`Go to message #${boundaryEntry.messageIndex}`}
              </Button>
            )}
          </p>
          {/* The divider is metadata: it adds no message and changes no index. */}
          <p className="m-0 text-[0.78rem] leading-[1.65] text-text-secondary">
            The checkpoint marks a boundary in the retained archive. No message
            was added, removed, or renumbered.
          </p>

          <EntryEvidence
            target={target}
            seq={boundarySeq}
            open={openEntrySeq === boundarySeq}
            onToggle={() =>
              setOpenEntrySeq((current) =>
                current === boundarySeq ? null : boundarySeq,
              )
            }
          />

          <ArchiveRange
            target={target}
            fromSeq={rangeFrom}
            toSeq={boundarySeq}
            onOpenEntry={setOpenEntrySeq}
            {...(onNavigateToMessage === undefined
              ? {}
              : { onNavigateToMessage })}
          />

          {openEntrySeq !== null && openEntrySeq !== boundarySeq && (
            <EntryEvidence
              target={target}
              seq={openEntrySeq}
              open
              onToggle={() => setOpenEntrySeq(null)}
            />
          )}
        </div>
      </CheckpointDisclosure>

      {artifactIsNewer && (
        <p
          className={ROW_CLASS}
          data-checkpoint-artifact-comparison="newer-artifact"
        >
          <StatusChip tone="amber" appearance="solid">
            Rolling artifact
          </StatusChip>
          <span>
            The reading artifact covers later history than this saved checkpoint
            (through raw seq {artifact.coveredEndSeq}, updated{" "}
            {artifact.updatedAt}). Neither view replaces the other.
          </span>
        </p>
      )}
    </section>
  );
}
