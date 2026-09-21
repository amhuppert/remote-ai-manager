import type { LoopGroupBox } from "@/lib/workflow-graph/loop-group-geometry";

/** A loop can span lanes; each segment repeats its identity and total body size. */
export default function LoopGroupSurface({ box }: { box: LoopGroupBox }) {
  const { loop } = box;
  const title = loop.title ?? loop.id;
  const count = loop.bodyContextIds.length;
  const membership =
    box.memberContextIds.length === count
      ? `${count} context${count === 1 ? "" : "s"}`
      : `${box.memberContextIds.length} of ${count} contexts`;
  return (
    <div
      role="group"
      aria-label={`Loop ${title} — ${membership}, max ${loop.maxPasses} passes`}
      data-testid="loop-group"
      data-loop-id={loop.id}
      className="pointer-events-none absolute rounded-lg border border-dashed border-border-strong bg-bg-raised/30 font-mono"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <div className="flex min-w-0 flex-col gap-2xs px-lg py-sm">
        <div className="flex min-w-0 items-center gap-sm text-[0.75rem] text-text-primary">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="shrink-0"
          >
            <path d="M12.5 5.5A5 5 0 0 0 3 6M3.5 10.5A5 5 0 0 0 13 10M12.5 2.5v3h-3M3.5 13.5v-3h3" />
          </svg>
          <span className="shrink-0 text-[0.7rem] tracking-wider text-text-secondary uppercase">
            Loop
          </span>
          <span className="truncate font-semibold" title={title}>
            {title}
          </span>
        </div>
        <span className="text-[0.7rem] text-text-secondary">
          {membership} · max {loop.maxPasses}{" "}
          {loop.maxPasses === 1 ? "pass" : "passes"}
        </span>
      </div>
    </div>
  );
}
