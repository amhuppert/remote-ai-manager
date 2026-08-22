// Execution-page glyphs the shared config-panel sprite does not carry. Drawn
// rather than typed: the design system forbids a Unicode character standing in
// for a functional icon, so play/stop/rail-toggle are SVG like every other
// control glyph.

interface GlyphProps {
  size?: number;
}

export function PlayIcon({ size = 11 }: GlyphProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 3.2 12.4 8l-7.9 4.8Z" />
    </svg>
  );
}

export function StopIcon({ size = 11 }: GlyphProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.2" />
    </svg>
  );
}

/** The right rail toggle: a panel with its side column outlined. */
export function PanelRightIcon({ size = 13 }: GlyphProps): React.JSX.Element {
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
      <rect x="2" y="3" width="12" height="10" rx="1.5" strokeWidth="1.3" />
      <path d="M10 3v10" strokeWidth="1.3" />
    </svg>
  );
}
