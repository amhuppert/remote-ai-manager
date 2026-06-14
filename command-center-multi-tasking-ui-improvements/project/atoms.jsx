// Small atoms shared across the prototype: icons, sparkline, status helpers.

const Icon = ({ name, size = 14, color = "currentColor", style }) => {
  const s = { width: size, height: size, color, ...(style || {}) };
  const path = {
    search: (
      <path
        d="M11 11l3 3M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    ),
    x: (
      <path
        d="M3.5 3.5l9 9m0-9l-9 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    ),
    plus: (
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    ),
    chevron: (
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    pin: (
      <path
        d="M10.5 1.5l4 4-3 2 1 4-5-1-3.5 3.5L3 13l3.5-3.5-1-5 4 1 1-4z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    ),
    sliders: (
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M2 4h7M11 4h3M2 8h3M7 8h7M2 12h9M13 12h1" />
        <circle cx="10" cy="4" r="1.4" fill="currentColor" />
        <circle cx="6" cy="8" r="1.4" fill="currentColor" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      </g>
    ),
    refresh: (
      <path
        d="M13 7a5 5 0 1 0-1.5 3.5M13 3v3.5h-3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    trash: (
      <path
        d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5l.5-9"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    bell: (
      <path
        d="M8 1.5v1.5M3.5 6.5a4.5 4.5 0 1 1 9 0v2.5l1.5 2H2l1.5-2V6.5zM6.5 13.5a1.5 1.5 0 0 0 3 0"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    layoutDefault: (
      <g stroke="currentColor" strokeWidth="1.3" fill="none">
        <rect x="1.5" y="2.5" width="9" height="11" rx="1" />
        <rect x="11" y="2.5" width="3.5" height="11" rx="1" />
      </g>
    ),
    layoutSplit: (
      <g stroke="currentColor" strokeWidth="1.3" fill="none">
        <rect x="1.5" y="2.5" width="6" height="11" rx="1" />
        <rect x="8.5" y="2.5" width="6" height="11" rx="1" />
      </g>
    ),
    layoutPanes: (
      <g stroke="currentColor" strokeWidth="1.3" fill="none">
        <rect x="1.5" y="2.5" width="6" height="5" rx="1" />
        <rect x="8.5" y="2.5" width="6" height="5" rx="1" />
        <rect x="1.5" y="8.5" width="6" height="5" rx="1" />
        <rect x="8.5" y="8.5" width="6" height="5" rx="1" />
      </g>
    ),
    layoutConvo: (
      <g stroke="currentColor" strokeWidth="1.3" fill="none">
        <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      </g>
    ),
    layoutDiff: (
      <g stroke="currentColor" strokeWidth="1.3" fill="none">
        <rect x="1.5" y="2.5" width="3" height="11" rx="1" />
        <rect x="5" y="2.5" width="9.5" height="11" rx="1" />
      </g>
    ),
    send: (
      <path
        d="M2 8l12-6-4 12-3-5-5-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinejoin="round"
      />
    ),
    openExternal: (
      <g
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 2h5v5M14 2L8 8M12 9v4H3V4h4" />
      </g>
    ),
    arrowUp: (
      <path
        d="M8 3l4 4M8 3l-4 4M8 3v10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    ),
    branch: (
      <g
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      >
        <circle cx="4" cy="3" r="1.4" />
        <circle cx="4" cy="13" r="1.4" />
        <circle cx="12" cy="6" r="1.4" />
        <path d="M4 4.4v7.2M4 8h5a3 3 0 0 0 3-3V7.4" />
      </g>
    ),
  }[name];
  return (
    <svg
      viewBox="0 0 16 16"
      style={s}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
};

// 30-bucket activity sparkline. Cyan, rendered as a smooth polyline.
const Sparkline = ({
  data,
  width = 56,
  height = 14,
  color = "var(--cyan)",
  muted,
}) => {
  if (!data || data.length === 0) return null;
  const max = Math.max(1, ...data);
  const stepX = width / (data.length - 1);
  const pts = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - 1 - (v / max) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  // Last-point dot
  const last = data[data.length - 1];
  const lastY = height - 1 - (last / max) * (height - 2);
  const allZero = data.every((v) => v === 0);
  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", overflow: "visible" }}
    >
      {!allZero && (
        <polyline
          points={pts}
          fill="none"
          stroke={muted ? "var(--text-tertiary)" : color}
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={muted ? 0.5 : 1}
        />
      )}
      {!allZero && (
        <circle
          cx={width}
          cy={lastY}
          r="1.6"
          fill={muted ? "var(--text-tertiary)" : color}
        />
      )}
      {allZero && (
        <line
          x1="0"
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke="var(--text-tertiary)"
          strokeWidth="1"
          strokeDasharray="2 2"
          opacity="0.4"
        />
      )}
    </svg>
  );
};

// Statuses match the prod app: new (blue), awaiting (green),
// running (cyan), waiting_for_input (amber). Nothing else.
const STATUS_LABEL = {
  new: "New",
  awaiting: "Awaiting",
  running: "Running",
  waiting_for_input: "Waiting for input",
};

Object.assign(window, { Icon, Sparkline, STATUS_LABEL });
