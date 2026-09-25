type IconProps = { size?: number; className?: string };

const baseSvgProps = {
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeWidth: 1.5,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
};

export function CloseIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export function PlusIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function CopyIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <rect x="8" y="8" width="12" height="12" />
      <path d="M4 16V4h12" />
    </svg>
  );
}

export function CheckIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}

export function ChevronDownIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function SearchIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  );
}

export function ArrowUpIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <line x1="12" y1="20" x2="12" y2="4" />
      <path d="M5 11l7-7 7 7" />
    </svg>
  );
}

/** "Open this elsewhere" — a jump out of the current surface, not navigation within it. */
export function ArrowUpRightIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <line x1="6" y1="18" x2="18" y2="6" />
      <path d="M8 6h10v10" />
    </svg>
  );
}

export function StarIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}

export function ChatIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M4 5h16v11H9l-5 4V5z" />
    </svg>
  );
}

export function KebabIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

export function BranchIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10M6 13c0-3 4-4 8-4" />
    </svg>
  );
}

export function TrashIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

export function StopIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

export function ArchiveIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="4" />
      <path d="M5 8v12h14V8M10 13h4" />
    </svg>
  );
}

export function ChevronLeftIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

/** Discard local edits — the counter-clockwise arc the Reset action wears. */
export function UndoIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9h9a5 5 0 0 1 0 10h-6M4 9l4-4M4 9l4 4" />
    </svg>
  );
}

/** Re-place the graph: the auto-layout action's arranged-blocks glyph. */
export function LayoutIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="7" height="7" />
      <rect x="14" y="4" width="7" height="7" />
      <rect x="3" y="14" width="7" height="6" />
      <rect x="14" y="14" width="7" height="6" />
    </svg>
  );
}

export function GearIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2" />
    </svg>
  );
}

export function AlertTriangleIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 22 20H2L12 3.5Z" />
      <path d="M12 9.5v4.5M12 17h.01" />
    </svg>
  );
}

export function DocumentIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M14 3H5v18h14V8z" />
      <path d="M14 3v5h5M8 12h8M8 16h6" />
    </svg>
  );
}

export function RefreshIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
    </svg>
  );
}

export function CompactIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M4 3v5h5M20 3v5h-5M4 21v-5h5M20 21v-5h-5M4 8l4-4M20 8l-4-4M4 16l4 4M20 16l-4 4" />
    </svg>
  );
}

export function HandoffIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M3 5h11v10H3zM8 19h13V9M10 10h10m-3-3 3 3-3 3" />
    </svg>
  );
}

export function CheckpointIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <path d="M6 3h12v18l-6-4-6 4z" />
      <path d="m9 9 2 2 4-4" />
    </svg>
  );
}

export function ServerStackIcon({ size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      {...baseSvgProps}
      aria-hidden="true"
    >
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
      <line x1="7" y1="7.25" x2="8" y2="7.25" />
      <line x1="7" y1="16.75" x2="8" y2="16.75" />
    </svg>
  );
}
