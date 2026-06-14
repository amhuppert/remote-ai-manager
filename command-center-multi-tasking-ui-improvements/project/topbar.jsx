// Topbar — logo, crumbs, status, layout switcher, actions.

const LAYOUTS = [
  { id: "convo", icon: "layoutConvo", label: "Conversation only" },
  { id: "default", icon: "layoutDefault", label: "Conversation + diff" },
  { id: "split", icon: "layoutSplit", label: "Split 50/50" },
  { id: "panes", icon: "layoutPanes", label: "Panes — multiple conversations" },
  { id: "diff", icon: "layoutDiff", label: "Diff only" },
];

const Topbar = ({ conv, layout, setLayout, runningCount, needsCount }) => {
  return (
    <header className="topbar">
      <div className="topbar__logo">CC</div>
      <nav className="topbar__crumbs">
        <a href="#" className="topbar__crumb">
          Projects
        </a>
        <span className="topbar__sep">/</span>
        <a href="#" className="topbar__crumb">
          {conv.project}
        </a>
        <span className="topbar__sep">/</span>
        <span className="topbar__crumb topbar__crumb--current">
          {conv.branch.split("/").pop()}
        </span>
      </nav>

      <div style={{ flex: 1 }} />

      {/* Global fleet status */}
      <div className="topbar__counter">
        <b>{runningCount}</b> running
        {needsCount > 0 && (
          <React.Fragment>
            {"  "}·{"  "}
            <span style={{ color: "var(--amber)" }}>
              <b style={{ color: "var(--amber)" }}>{needsCount}</b> needs you
            </span>
          </React.Fragment>
        )}
      </div>

      <div className="topbar__status">
        <span className="dot" />
        {STATUS_LABEL[conv.status]}
      </div>

      {/* Layout switcher */}
      <div className="topbar__group" role="tablist" aria-label="Layout">
        {LAYOUTS.map((l) => (
          <button
            key={l.id}
            className={"topbar__icon-btn" + (layout === l.id ? " active" : "")}
            title={l.label}
            onClick={() => setLayout(l.id)}
          >
            <Icon name={l.icon} size={14} />
          </button>
        ))}
      </div>

      <div className="topbar__group">
        <button className="topbar__icon-btn" title="Refresh">
          <Icon name="refresh" size={14} />
        </button>
        <button className="topbar__icon-btn" title="Notifications">
          <Icon name="bell" size={14} />
        </button>
        <button className="topbar__icon-btn" title="Delete conversation">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </header>
  );
};

Object.assign(window, { Topbar });
