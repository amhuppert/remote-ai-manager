import { cn } from "@/lib/ui/cn";

interface ConversationNavProps {
  currentIndex: number;
  totalCount: number;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onLast: () => void;
}

// `msg-nav`, `nav-btn`, and `msg-counter` are retained as hooks for two slices'
// mobile overrides re-homed here: the general ≤768px touch-sizing (44×44, from the
// globals `.nav-btn`/`.msg-nav` rule) AND the prompt-panel-header tweaks (smaller
// nav `svg`). The svg override is `!` so it beats the unlayered globals
// `.nav-btn svg { 16px }` rule (layered utilities otherwise lose to unlayered CSS).
const navBtn =
  "nav-btn flex items-center justify-center w-[24px] h-[24px] p-0 border border-solid border-border-subtle bg-transparent text-text-tertiary text-[0.7rem] cursor-pointer transition-all duration-150 ease-[ease] [&_svg]:w-[16px] [&_svg]:h-[16px] [&_svg]:shrink-0 max-768:[&_svg]:w-[14px]! max-768:[&_svg]:h-[14px]! hover:bg-bg-hover hover:text-text-secondary hover:border-border-default hover:z-[1] max-768:w-[44px] max-768:h-[44px] max-768:min-w-[44px] max-768:min-h-[44px] max-768:text-[0.72rem]";
const navBtnLeft = cn(navBtn, "rounded-l-sm rounded-r-none");
const navBtnRight = cn(navBtn, "-ml-px rounded-l-none rounded-r-sm");

export default function ConversationNav({
  currentIndex,
  totalCount,
  onFirst,
  onPrevious,
  onNext,
  onLast,
}: ConversationNavProps) {
  const isEmpty = totalCount === 0;

  return (
    <div className="msg-nav flex items-center gap-sm max-768:flex-1 max-768:justify-between max-768:gap-[4px]">
      <div className="flex">
        <button className={navBtnLeft} onClick={onFirst} title="First message">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <line
              x1="2"
              y1="1.5"
              x2="8"
              y2="1.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M2 8L5 4L8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className={navBtnRight}
          onClick={onPrevious}
          title="Previous message"
        >
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 4.5L5 1.5L8.5 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <span className="msg-counter min-w-[28px] text-center font-mono text-[0.7rem] tracking-[0.02em] text-text-tertiary max-768:min-w-[24px] max-768:text-[0.66rem]">
        {isEmpty ? "0 / 0" : `${currentIndex + 1} / ${totalCount}`}
      </span>
      <div className="flex">
        <button className={navBtnLeft} onClick={onNext} title="Next message">
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 1.5L5 4.5L8.5 1.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className={navBtnRight} onClick={onLast} title="Last message">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 2L5 6L8 2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="2"
              y1="8.5"
              x2="8"
              y2="8.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
