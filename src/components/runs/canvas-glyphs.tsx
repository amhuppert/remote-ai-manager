/**
 * The canvas control cluster's marks, drawn as SVG.
 *
 * §13 forbids a Unicode character standing in for a functional icon, so `−`,
 * `+` and the fit corners are paths. Every control that uses one carries its
 * own accessible name, which is why each glyph is `aria-hidden`.
 */

function Glyph({
  size = 12,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {children}
    </svg>
  );
}

export function ZoomOutGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph {...(size === undefined ? {} : { size })}>
      <path
        d="M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

export function ZoomInGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph {...(size === undefined ? {} : { size })}>
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

export function FitGlyph({ size }: { size?: number }): React.JSX.Element {
  return (
    <Glyph {...(size === undefined ? {} : { size })}>
      <path
        d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}
