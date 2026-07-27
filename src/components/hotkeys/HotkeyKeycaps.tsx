import { Fragment } from "react";
import { formatHotkeyDisplay, getHotkeySequences } from "@/lib/shared/hotkeys";

function keycapLabel(part: string): string {
  return formatHotkeyDisplay(part);
}

export function HotkeyKeycaps({
  keys,
}: {
  readonly keys: string | null;
}): React.JSX.Element {
  const sequences = getHotkeySequences(keys);
  if (sequences.length === 0) {
    return (
      <span className="font-mono text-[0.68rem] text-text-tertiary">
        Command menu
      </span>
    );
  }

  return (
    <span
      aria-label={formatHotkeyDisplay(keys)}
      className="inline-flex flex-wrap items-center justify-end gap-[4px]"
    >
      {sequences.map((sequence, sequenceIndex) => (
        <Fragment key={sequence.join("+")}>
          {sequenceIndex > 0 ? (
            <span className="px-[2px] font-mono text-[0.62rem] text-text-tertiary">
              or
            </span>
          ) : null}
          {sequence.map((stroke, strokeIndex) => (
            <Fragment key={`${stroke}-${strokeIndex}`}>
              {strokeIndex > 0 ? (
                <span className="font-mono text-[0.62rem] text-text-tertiary">
                  then
                </span>
              ) : null}
              <kbd className="inline-flex min-w-[24px] items-center justify-center rounded-sm border border-solid border-border-default bg-bg-raised px-[7px] py-[2px] font-mono text-[0.68rem] leading-[1.5] text-text-secondary">
                {keycapLabel(stroke)}
              </kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
