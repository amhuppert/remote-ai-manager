// Panes mode — N=2..6 conversations laid out in an adaptive grid.
// Shares the openTabs set with the tabs strip (different layout, same juggled set).

// Compact pane message — no avatar, denser type, tool calls collapsed to one line.
const PaneMessage = ({ msg, compact }) => (
  <div className={"pane-msg pane-msg--" + msg.role}>
    <span className="pane-msg__role">{msg.role === "user" ? "You" : "CC"}</span>
    <div className="pane-msg__body">
      <div className="pane-msg__text">
        {compact ? truncate(msg.text, 180) : truncate(msg.text, 320)}
      </div>
      {msg.tool && (
        <div className="pane-msg__tool">
          <span className="pane-msg__tool-name">{msg.tool.name}</span>
          <code>{msg.tool.detail}</code>
        </div>
      )}
    </div>
  </div>
);

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

// Pick recent messages for a pane.
function messagesFor(conv) {
  if (conv.id === "gc-multitasking") {
    // The current conversation has the full transcript; show its tail.
    return window.MOCK.currentTranscript.slice(-4);
  }
  return window.MOCK.peekTranscripts[conv.id] || [];
}

const Pane = ({
  conv,
  active,
  compact,
  paneCount,
  onActivate,
  onClose,
  onOpenFull,
  onContext,
}) => {
  const messages = messagesFor(conv);
  const visibleN = compact ? 2 : 4;
  const shown = messages.slice(-visibleN);
  const hidden = Math.max(0, messages.length - shown.length);

  const isWaiting = conv.status === "waiting_for_input";

  return (
    <div
      className={
        "pane" +
        (active ? " active" : "") +
        (compact ? " compact" : "") +
        (isWaiting ? " needs" : "")
      }
      onClick={() => !active && onActivate(conv.id)}
      onContextMenu={(e) => onContext(conv, e)}
    >
      <header className="pane__head">
        <span className={"row__dot row__dot--" + conv.status} />
        <span className="pane__title" title={conv.title}>
          {conv.title}
        </span>
        <button
          className="pane__icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFull(conv.id);
          }}
          title="Open full conversation"
        >
          <Icon name="openExternal" size={11} />
        </button>
        <button
          className="pane__icon-btn pane__icon-btn--close"
          onClick={(e) => {
            e.stopPropagation();
            onClose(conv.id);
          }}
          title="Remove from panes (does not stop the agent)"
        >
          <Icon name="x" size={11} />
        </button>
      </header>

      <div className="pane__meta">
        {!isWaiting && (
          <React.Fragment>
            <span className={"peek__status peek__status--" + conv.status}>
              {STATUS_LABEL[conv.status]}
            </span>
            <span className="pane__sep">·</span>
          </React.Fragment>
        )}
        <span className="pane__proj">{conv.project}</span>
        <span className="pane__sep">/</span>
        <span className="pane__sess">{conv.session}</span>
        <span className="pane__time">{conv.timeLabel}</span>
      </div>

      {isWaiting && (
        <div className="pane__banner pane__banner--awaiting">
          <span className="pane__banner-label">Agent asks</span>
          <span className="pane__banner-text">{conv.awaitingQuestion}</span>
        </div>
      )}
      {!isWaiting && (
        <div className="pane__status-line">
          {conv.currentTool && (
            <span className="pane__tool-chip">{conv.currentTool}</span>
          )}
          {conv.statusLine}
        </div>
      )}

      <div className="pane__body">
        {hidden > 0 && (
          <div className="pane__hidden">
            + {hidden} earlier {hidden === 1 ? "message" : "messages"}
          </div>
        )}
        {shown.length === 0 ? (
          <div className="pane__empty">No messages yet.</div>
        ) : (
          shown.map((m, i) => <PaneMessage key={i} msg={m} compact={compact} />)
        )}
      </div>
    </div>
  );
};

// Grid sizing rule — keeps each pane wide enough to be useful.
// The 5-pane case uses an asymmetric layout: 3 panes on the top row at 1/3 width,
// 2 panes on the bottom row at 1/2 width — much more balanced than 3x2 with a hole.
function gridShape(n) {
  if (n <= 2) return { cols: n || 1, rows: 1, shape: String(n) };
  if (n === 3) return { cols: 3, rows: 1, shape: "3" };
  if (n === 4) return { cols: 2, rows: 2, shape: "4" };
  if (n === 5) return { cols: 6, rows: 2, shape: "5" }; // 3 panes span 2, 2 panes span 3
  if (n === 6) return { cols: 3, rows: 2, shape: "6" };
  return { cols: 3, rows: 3, shape: "many" };
}

const PanesView = ({
  paneIds,
  activeId,
  allConvs,
  composerFocused,
  paneSeparator,
  onActivate,
  onClose,
  onOpenFull,
  onContext,
}) => {
  const panes = paneIds
    .map((id) => allConvs.find((c) => c.id === id))
    .filter(Boolean);

  const { cols, rows, shape } = gridShape(panes.length);
  const compact = panes.length >= 3;

  return (
    <section
      className="panes"
      style={{ "--cols": cols, "--rows": rows }}
      data-shape={shape}
      data-separator={paneSeparator || "shadow"}
      data-composer-focused={composerFocused ? "true" : "false"}
    >
      <div className="panes__grid">
        {panes.map((c) => (
          <Pane
            key={c.id}
            conv={c}
            active={c.id === activeId}
            compact={compact}
            paneCount={panes.length}
            onActivate={onActivate}
            onClose={onClose}
            onOpenFull={onOpenFull}
            onContext={onContext}
          />
        ))}
      </div>
    </section>
  );
};

Object.assign(window, { PanesView });
