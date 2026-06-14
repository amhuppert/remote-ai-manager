// Global composer — single prompt input pinned to the bottom of the screen.
// Sends to whichever conversation is currently active (current pane / current tab).

const BACKENDS = ["Claude", "Codex"];
const MODELS = {
  Claude: ["Opus", "Sonnet", "Haiku"],
  Codex: ["GPT-5", "GPT-5 mini", "o3"],
};
const EFFORTS = ["Min", "Low", "Med", "High", "XHigh"];

// Small reusable dropdown — used for model + effort selects.
const ComposerDropdown = ({
  value,
  options,
  onChange,
  accent,
  align = "left",
}) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      className={"cmp-dd" + (open ? " open" : "") + (accent ? " accent" : "")}
      ref={ref}
    >
      <button
        type="button"
        className="cmp-dd__btn"
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.preventDefault()} // don't steal focus from textarea
      >
        <span className="cmp-dd__value">{value}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path
            d="M1.5 3l2.5 2.5L6.5 3"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className={"cmp-dd__menu cmp-dd__menu--" + align}>
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={"cmp-dd__item" + (opt === value ? " active" : "")}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const ComposerSegmented = ({ value, options, onChange }) => (
  <div className="cmp-seg" role="radiogroup">
    {options.map((o) => (
      <button
        key={o}
        type="button"
        role="radio"
        aria-checked={value === o}
        className={"cmp-seg__btn" + (value === o ? " active" : "")}
        onClick={() => onChange(o)}
        onMouseDown={(e) => e.preventDefault()}
      >
        {o}
      </button>
    ))}
  </div>
);

const GlobalComposer = ({ activeConv, onFocusChange }) => {
  const [val, setVal] = React.useState("");
  const [backend, setBackend] = React.useState("Claude");
  const [model, setModel] = React.useState("Opus");
  const [effort, setEffort] = React.useState("XHigh");
  const [debug, setDebug] = React.useState(false);
  const textRef = React.useRef(null);

  const send = () => {
    if (!val.trim()) return;
    // Prototype: just clear the input
    setVal("");
  };
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  // Switching backend resets the model to that backend's default.
  const setBackendAndModel = (b) => {
    setBackend(b);
    setModel(MODELS[b][0]);
  };

  return (
    <footer className="composer-global">
      <div
        className="composer-global__target"
        title="Prompt will be sent to this conversation"
      >
        <span className="composer-global__target-label">Send to</span>
        <span className={"row__dot row__dot--" + activeConv.status} />
        <span className="composer-global__target-title">
          {activeConv.title}
        </span>
        <span className="composer-global__target-sub">
          <span className="proj">{activeConv.project}</span>
          <span className="sep">/</span>
          <span className="sess">{activeConv.session}</span>
        </span>
      </div>

      <div className="composer-global__box">
        <textarea
          ref={textRef}
          placeholder={`Send a prompt to ${activeConv.title} · ⌘⏎ to send`}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          onKeyDown={onKeyDown}
          rows={2}
        />

        <div className="composer-global__row">
          <button
            type="button"
            className="composer-global__icon-btn"
            title="Attach image"
            onMouseDown={(e) => e.preventDefault()}
          >
            <AttachIcon />
          </button>

          <ComposerSegmented
            value={backend}
            options={BACKENDS}
            onChange={setBackendAndModel}
          />

          <ComposerDropdown
            value={model}
            options={MODELS[backend]}
            onChange={setModel}
          />

          <ComposerDropdown
            value={effort}
            options={EFFORTS}
            onChange={setEffort}
            accent
          />

          <button
            type="button"
            className={
              "composer-global__chip composer-global__chip--debug" +
              (debug ? " active" : "")
            }
            onClick={() => setDebug(!debug)}
            onMouseDown={(e) => e.preventDefault()}
            title={debug ? "Debug mode on" : "Debug mode off"}
          >
            <span
              className={"composer-global__chip-dot" + (debug ? " on" : "")}
            />
            Debug
          </button>

          <button
            type="button"
            className="composer-global__chip composer-global__chip--mcp"
            onMouseDown={(e) => e.preventDefault()}
            title="MCP servers — 4 of 4 enabled"
          >
            <McpIcon />
            <span>MCP</span>
            <span className="composer-global__chip-meta">· 4/4</span>
          </button>

          <button
            type="button"
            className="composer-global__send"
            onClick={send}
            onMouseDown={(e) => e.preventDefault()}
            title="Send (⌘⏎)"
            disabled={!val.trim()}
          >
            <Icon name="send" size={12} />
          </button>
        </div>
      </div>
    </footer>
  );
};

const AttachIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M10.5 3.5L4.7 9.3a2.2 2.2 0 0 0 3.1 3.1l6.4-6.4a3.5 3.5 0 0 0-4.9-4.9L2.9 7.5a4.8 4.8 0 0 0 6.8 6.8l5.4-5.4"
      stroke="currentColor"
      strokeWidth="1.3"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const McpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7l5-4 5 4v6H3z" />
      <path d="M6 13V9h4v4" />
    </g>
  </svg>
);

Object.assign(window, { GlobalComposer });
