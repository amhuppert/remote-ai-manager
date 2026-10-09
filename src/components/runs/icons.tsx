/**
 * Glyphs the run page needs that the canonical set (`src/components/icons.tsx`)
 * lacks, drawn to its conventions: 24px viewBox, 1.5 stroke, square caps,
 * currentColor. Candidates for the canonical set once the page ships.
 */

type IconProps = { size?: number };

const stroke = {
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeWidth: 1.5,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
};

function Svg({
  size = 16,
  children,
  filled = false,
}: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      {...(filled ? { fill: "currentColor" } : stroke)}
    >
      {children}
    </svg>
  );
}

export function PauseIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <line x1="9" y1="6" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="18" />
    </Svg>
  );
}

export function PlayIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 5.5v13l10-6.5z" />
    </Svg>
  );
}

export function ListIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <line x1="9" y1="6.5" x2="20" y2="6.5" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="17.5" x2="20" y2="17.5" />
      <line x1="4.5" y1="6.5" x2="5.5" y2="6.5" />
      <line x1="4.5" y1="12" x2="5.5" y2="12" />
      <line x1="4.5" y1="17.5" x2="5.5" y2="17.5" />
    </Svg>
  );
}

export function DiagramIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="6" height="5" />
      <rect x="15" y="4" width="6" height="5" />
      <rect x="9" y="15" width="6" height="5" />
      <path d="M6 9v3h6v3M18 9v3h-6" />
    </Svg>
  );
}

export function LoopIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M17 8H8a4 4 0 0 0 0 8h1" />
      <path d="M7 16h9a4 4 0 0 0 0-8h-1" />
      <path d="M14.5 5.5 17 8l-2.5 2.5" />
    </Svg>
  );
}

export function WaitingIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="6.5" strokeDasharray="2.5 2.5" />
    </Svg>
  );
}

export function SkippedIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="6.5" />
      <line x1="8.5" y1="12" x2="15.5" y2="12" />
    </Svg>
  );
}

export function ApprovalIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z" />
      <path d="m8.8 12 2.2 2.2 4.4-4.4" />
    </Svg>
  );
}

export function QuestionIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 5h16v11h-9l-4 3.5V16H4z" />
      <path d="M10 9a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1v.4" />
      <line x1="12" y1="14" x2="12" y2="14.2" />
    </Svg>
  );
}
