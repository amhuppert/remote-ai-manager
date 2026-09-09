"use client";

import { useState } from "react";

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
  "font-mono text-[10px] font-bold tracking-[0.16em] text-text-tertiary uppercase";
const ROW_CLASS =
  "flex flex-wrap items-center gap-x-sm gap-y-2xs font-mono text-[0.72rem] text-text-secondary";
const LINK_CLASS =
  "inline-flex items-center gap-2xs rounded-sm border border-solid border-border-default bg-bg-raised px-[6px] py-[2px] font-mono text-[0.7rem] text-text-primary no-underline transition-[border-color,background] duration-150 ease-[ease] hover:border-cyan hover:bg-bg-hover";
const BODY_CLASS =
  "m-0 max-h-[320px] overflow-auto rounded-sm border border-solid border-border-subtle bg-bg-base px-sm py-xs font-mono text-[0.72rem] whitespace-pre-wrap text-text-primary";

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
    <div className="flex flex-col gap-2xs" data-checkpoint-entry-seq={seq}>
      <p className={ROW_CLASS}>
        {/* Opening it in place keeps the reader in the conversation the
            evidence belongs to; the raw export stays one link away for
            anything a panel cannot usefully render. */}
        <Button
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
        {entry !== null && (
          <span>
            {entry.bytes} bytes · sha256 {entry.sha256}
          </span>
        )}
      </p>
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
                        className="flex-1 cursor-pointer rounded-sm border border-solid border-transparent bg-transparent px-xs py-2xs text-left font-mono text-[0.72rem] text-text-primary hover:border-border-default hover:bg-bg-hover"
                        onClick={() => onOpenEntry(primary)}
                      >
                        <Badge tier="count">{`s${primary}`}</Badge>{" "}
                        {`${unit.role} · ${unit.lines[0] ?? "(no rendered text)"}`}
                      </button>
                      {onNavigateToMessage !== undefined && (
                        <Button
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
  target,
  receipt,
  previousBoundarySeq = null,
  onNavigateToMessage,
  artifact,
}: CheckpointEvidenceProps): React.JSX.Element {
  const [seedShown, setSeedShown] = useState(false);
  const boundarySeq = receipt.boundary.capturedThroughSeq;
  // Which entry's body is open. It follows the selected checkpoint by
  // defaulting to the boundary, and an outlined row moves it into the window.
  const [openEntrySeq, setOpenEntrySeq] = useState<number | null>(null);

  const boundaryEntryQuery = useHistoryEntryMetadata(target, boundarySeq);
  const boundaryEntry = boundaryEntryQuery.data?.entry ?? null;

  const seedQuery = useCheckpointSeedQuery(target, receipt.operationId, {
    enabled: seedShown,
  });

  const artifactIsNewer =
    artifact != null && artifact.coveredEndSeq > boundarySeq;
  const rangeFrom =
    previousBoundarySeq === null ? 0 : Math.max(0, previousBoundarySeq + 1);

  return (
    <section className="flex flex-col gap-sm" data-checkpoint-evidence="">
      <h3 className={LABEL_CLASS}>Original evidence</h3>

      <p className={ROW_CLASS} data-checkpoint-boundary="">
        <span>Derived boundary: captured through raw seq {boundarySeq}</span>
        {boundaryEntry !== null && (
          <span>· message #{boundaryEntry.messageIndex}</span>
        )}
        {boundaryEntry !== null && onNavigateToMessage !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onNavigateToMessage(boundaryEntry.messageIndex)}
          >
            {`Go to message #${boundaryEntry.messageIndex}`}
          </Button>
        )}
      </p>
      {/* The divider is metadata: it adds no message and changes no index. */}
      <p className="m-0 text-[0.78rem] text-text-tertiary">
        The boundary is read metadata over the retained archive — no message was
        added, removed, or renumbered by this checkpoint.
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
        {...(onNavigateToMessage === undefined ? {} : { onNavigateToMessage })}
      />

      {openEntrySeq !== null && openEntrySeq !== boundarySeq && (
        <EntryEvidence
          target={target}
          seq={openEntrySeq}
          open
          onToggle={() => setOpenEntrySeq(null)}
        />
      )}

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

      {receipt.checkpoint !== null && (
        <div className="flex flex-col gap-xs">
          <Button
            size="sm"
            variant="default"
            onClick={() => setSeedShown((shown) => !shown)}
            aria-expanded={seedShown}
          >
            {seedShown
              ? "Hide saved handoff"
              : `Show saved handoff (${receipt.checkpoint.sectionBytes.total} bytes)`}
          </Button>
          {seedShown && (
            <div className="flex flex-col gap-2xs">
              {seedQuery.isLoading && (
                <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
                  Reading the saved handoff…
                </p>
              )}
              {seedQuery.data?.seed != null && (
                // The exact frozen bytes, never a re-render of them: the seed
                // is the string the next turn actually received.
                <pre className={BODY_CLASS}>{seedQuery.data.seed.seedText}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
