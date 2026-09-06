"use client";

import { WithTooltip } from "@/components/ui/WithTooltip";

const TOOLTIP_TEXT =
  "This independent conversation starts with a bounded text excerpt through the fork point. Images, tool state, and hidden provider context are not copied.";

export default function SyntheticForkBadge(): React.JSX.Element {
  return (
    <WithTooltip label={TOOLTIP_TEXT}>
      <span
        className="inline-flex cursor-help items-center justify-center gap-[4px] rounded-full px-[8px] py-[2px] font-mono text-[0.7rem] leading-[1.3] font-semibold whitespace-nowrap lowercase opacity-50"
        aria-label="synthetic fork"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
          <path
            d="M6 5.5V8.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <circle cx="6" cy="3.6" r="0.7" fill="currentColor" />
        </svg>
        synthetic fork
      </span>
    </WithTooltip>
  );
}
