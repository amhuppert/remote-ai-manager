"use client";

import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";

export interface CodexSpeedToggleProps {
  fastMode: boolean;
  onFastModeChange(enabled: boolean): void;
  disabled?: boolean;
  presentation?: "compact" | "fullWidth";
}

export default function CodexSpeedToggle({
  fastMode,
  onFastModeChange,
  disabled = false,
  presentation = "compact",
}: CodexSpeedToggleProps): React.JSX.Element {
  const fullWidth = presentation === "fullWidth";

  return (
    <SegmentedControl
      aria-label="Codex speed"
      value={fastMode ? "fast" : "standard"}
      onValueChange={(value) => onFastModeChange(value === "fast")}
      disabled={disabled}
      layoutClassName={fullWidth ? "flex w-full" : undefined}
    >
      <SegmentedControlItem
        value="standard"
        tone="violet"
        layoutClassName={fullWidth ? "flex-1" : undefined}
      >
        Standard
      </SegmentedControlItem>
      <SegmentedControlItem
        value="fast"
        tone="violet"
        layoutClassName={fullWidth ? "flex-1" : undefined}
      >
        Fast
      </SegmentedControlItem>
    </SegmentedControl>
  );
}
