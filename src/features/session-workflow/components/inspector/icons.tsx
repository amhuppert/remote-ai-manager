// Inspector-owned glyphs. Everything functional in the rail is a drawn SVG —
// the design system forbids a Unicode character standing in for an icon.

interface GlyphProps {
  size?: number;
}

/** A task row's disclosure mark; the row rotates it when expanded. */
export function DisclosureChevronIcon({
  size = 11,
}: GlyphProps): React.JSX.Element {
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
      <path
        d="M6 3.5 10.5 8 6 12.5"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The loop chip's mark: a pass inside a loop group. */
export function LoopIcon({ size = 11 }: GlyphProps): React.JSX.Element {
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
      <path
        d="M3 8a5 5 0 0 1 8.5-3.5M13 8a5 5 0 0 1-8.5 3.5"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11.5 2v2.6H9M4.5 14v-2.6H7"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
