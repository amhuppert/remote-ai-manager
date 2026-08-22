// The panel's canonical SVG icons. Every functional glyph in the config panel
// is one of these — the design system forbids a Unicode character standing in
// for an icon, so the back chevron and the reset arrow are drawn, not typed.

interface GlyphProps {
  size?: number;
}

function Stroke({
  size = 13,
  children,
}: GlyphProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ChevronRightIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M6 3.5 10.5 8 6 12.5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}

export function ChevronLeftIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M10 3.5 5.5 8 10 12.5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}

/** The reset-to-inherit arc: an override falling back to its parent tier. */
export function ResetInheritIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M3 8a5 5 0 1 1 1.6 3.7"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M3 4.4V8h3.6"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}

export function LockIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <rect x="3.2" y="7" width="9.6" height="6.8" rx="1.2" strokeWidth="1.4" />
      <path
        d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Stroke>
  );
}

export function AlertTriangleIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M8 2.8 14.2 13.2H1.8Z"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 6.6v3M8 11.4v.1" strokeWidth="1.4" strokeLinecap="round" />
    </Stroke>
  );
}

export function CheckIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M3.2 8.4 6.4 11.6 12.8 4.8"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}

export function PauseIcon({ size = 13 }: GlyphProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="3.5" width="2.6" height="9" rx="0.8" />
      <rect x="9.4" y="3.5" width="2.6" height="9" rx="0.8" />
    </svg>
  );
}

export function PlusIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M8 3.5v9M3.5 8h9" strokeWidth="1.4" strokeLinecap="round" />
    </Stroke>
  );
}

export function CloseIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M4.5 4.5l7 7M11.5 4.5l-7 7"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Stroke>
  );
}

export function ArrowUpIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}

export function ArrowDownIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M8 3.5V12M4.5 8.5 8 12l3.5-3.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}

export function TrashIcon(props: GlyphProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path
        d="M3.5 4.5h9M6.5 4.5V3.2h3v1.3M5 4.5l.6 8.3h4.8L11 4.5"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Stroke>
  );
}
