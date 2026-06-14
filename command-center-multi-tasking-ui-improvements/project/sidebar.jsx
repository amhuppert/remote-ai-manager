// Enriched sidebar — Active Conversations panel.
// Rows carry: status dot, title, time, what-it's-doing-now line,
// session chip, sibling count, sparkline. (Diff stat dropped — lives in info-strip.)

const SIDEBAR_FILTERS = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs" },
  { id: "running", label: "Run" },
  { id: "session", label: "Session" },
];

const SidebarFilters = ({ filter, setFilter, counts }) => (
  <div className="sidebar__filters" role="tablist">
    {SIDEBAR_FILTERS.map((f) => (
      <button
        key={f.id}
        role="tab"
        aria-selected={filter === f.id}
        className={"sidebar__filter" + (filter === f.id ? " active" : "")}
        onClick={() => setFilter(f.id)}
        title={
          f.id === "needs"
            ? "Conversations waiting for your input"
            : f.id === "running"
              ? "Currently running"
              : f.id === "session"
                ? "Only conversations in the current session"
                : "All conversations"
        }
      >
        {f.label}
        <span className="badge">{counts[f.id]}</span>
      </button>
    ))}
  </div>
);

const ConvRow = ({
  conv,
  current,
  density,
  showSparkline,
  showSession,
  sessionGroupPos, // null | "first" | "mid" | "last" | "only"
  onClick,
  onContextMenu,
}) => {
  const isWaiting = conv.status === "waiting_for_input";
  const isAwaiting = conv.status === "awaiting";
  const isNew = conv.status === "new";
  const isRunning = conv.status === "running";
  const muted = isAwaiting || isNew;

  const statusClass = isWaiting
    ? "row__status--waiting"
    : isAwaiting
      ? "row__status--awaiting"
      : isNew
        ? "row__status--new"
        : "";

  const inGroup = sessionGroupPos !== null;
  const groupClass = inGroup
    ? " in-session-group" +
      (sessionGroupPos === "first" ? " session-first" : "") +
      (sessionGroupPos === "last" ? " session-last" : "") +
      (sessionGroupPos === "only" ? " session-first session-last" : "")
    : "";

  return (
    <div
      className={
        "row" +
        (current ? " current" : "") +
        (isWaiting ? " needs" : "") +
        (density === "compact" ? " compact" : "") +
        (showSession ? " with-session" : "") +
        groupClass
      }
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="row__top">
        <span className={"row__dot row__dot--" + conv.status} />
        <span className="row__title">{conv.title}</span>
        <span className="row__time">{conv.timeLabel}</span>
      </div>

      {density !== "compact" && (
        <div className={"row__status " + statusClass}>
          {isWaiting && <span className="row__status-prefix">Asks ›</span>}
          {isNew && <span className="row__status-prefix">New ›</span>}
          {isRunning && conv.currentTool && (
            <span className="row__status-prefix">{conv.currentTool} ›</span>
          )}
          {isWaiting ? conv.awaitingQuestion : conv.statusLine}
        </div>
      )}

      {density !== "compact" && showSparkline && (
        <div className="row__meta">
          <span className="row__spark">
            <Sparkline data={conv.activity} muted={muted} />
          </span>
        </div>
      )}
    </div>
  );
};

// Order conversations: keep input order, but cluster same-session entries adjacent.
function clusterBySession(convs) {
  const seen = new Set();
  const out = [];
  for (const c of convs) {
    if (seen.has(c.id)) continue;
    out.push(c);
    seen.add(c.id);
    const siblings = convs.filter(
      (o) => o.session === c.session && o.id !== c.id && !seen.has(o.id),
    );
    for (const s of siblings) {
      out.push(s);
      seen.add(s.id);
    }
  }
  return out;
}

// Compute the position of each conv within its session group, for the visual connector.
function annotateSessionPos(convs) {
  return convs.map((c, i) => {
    const prev = convs[i - 1];
    const next = convs[i + 1];
    const samePrev = prev && prev.session === c.session;
    const sameNext = next && next.session === c.session;
    if (!samePrev && !sameNext) return { ...c, _pos: null };
    if (samePrev && sameNext) return { ...c, _pos: "mid" };
    if (!samePrev && sameNext) return { ...c, _pos: "first" };
    if (samePrev && !sameNext) return { ...c, _pos: "last" };
    return { ...c, _pos: null };
  });
}

// Group conversations by an arbitrary key, preserving first-seen order.
function groupBy(convs, keyFn) {
  const order = [];
  const groups = {};
  for (const c of convs) {
    const k = keyFn(c);
    if (!groups[k]) {
      groups[k] = [];
      order.push(k);
    }
    groups[k].push(c);
  }
  return order.map((name) => ({ name, items: groups[name] }));
}

const Sidebar = ({
  tweaks,
  setTweak,
  currentId,
  filter,
  setFilter,
  onPeek,
  onContext,
}) => {
  const [query, setQuery] = React.useState("");

  const all = window.MOCK.conversations;
  const current = all.find((c) => c.id === currentId);
  const currentSession = current?.session;

  const counts = {
    all: all.length,
    needs: all.filter((c) => c.status === "waiting_for_input").length,
    running: all.filter((c) => c.status === "running").length,
    session: all.filter((c) => c.session === currentSession).length,
  };

  let filtered = all;
  if (filter === "needs")
    filtered = all.filter((c) => c.status === "waiting_for_input");
  if (filter === "running")
    filtered = all.filter((c) => c.status === "running");
  if (filter === "session")
    filtered = all.filter((c) => c.session === currentSession);
  if (query.trim()) {
    const q = query.toLowerCase();
    filtered = filtered.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.project.toLowerCase().includes(q) ||
        c.session.toLowerCase().includes(q),
    );
  }

  const enriched = tweaks.enrichedSidebar;
  const density = enriched ? tweaks.sidebarDensity : "compact";
  const showSparkline = enriched && tweaks.showSparkline;
  const showNeedsYou = enriched && tweaks.showNeedsYou;
  const groupByKey = tweaks.groupBy || "project"; // "project" | "session"
  const showSession = enriched && groupByKey === "project"; // session chip only useful when grouping by project

  // Build sections: optional "Needs you" pinned on top, then grouped by the chosen key.
  // Same-session conversations are always adjacent within their group.
  const sections = [];

  const pushGrouped = (items, keyFn, kind) => {
    for (const g of groupBy(items, keyFn)) {
      const clustered = clusterBySession(g.items);
      const annotated = annotateSessionPos(clustered);
      sections.push({ kind, name: g.name, items: annotated });
    }
  };

  if (showNeedsYou && filter === "all") {
    const needs = filtered.filter((c) => c.status === "waiting_for_input");
    if (needs.length) {
      // Even in the "Needs you" pile, cluster same-session adjacent.
      const annotated = annotateSessionPos(clusterBySession(needs));
      sections.push({ kind: "needs", items: annotated });
    }
    const rest = filtered.filter((c) => c.status !== "waiting_for_input");
    if (groupByKey === "session") {
      // group by session, label "project / session"
      pushGrouped(rest, (c) => c.session, "session");
    } else {
      pushGrouped(rest, (c) => c.project, "project");
    }
  } else {
    if (groupByKey === "session") {
      pushGrouped(filtered, (c) => c.session, "session");
    } else {
      pushGrouped(filtered, (c) => c.project, "project");
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <div className="sidebar__title-row">
          <span className="sidebar__title">Active Conversations</span>
          <span className="sidebar__count">({all.length})</span>
          <div className="sidebar__title-actions">
            <button className="topbar__icon-btn" title="New conversation">
              <Icon name="plus" size={14} />
            </button>
          </div>
        </div>
        <div className="sidebar__search">
          <Icon name="search" size={12} color="var(--text-tertiary)" />
          <input
            placeholder="Filter conversations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9.5,
              color: "var(--text-tertiary)",
            }}
          >
            ⌘K
          </span>
        </div>
        <SidebarFilters filter={filter} setFilter={setFilter} counts={counts} />
        <div className="sidebar__group-row">
          <span className="sidebar__group-label">Group by</span>
          <GroupBySwitch
            value={groupByKey}
            onChange={(v) => setTweak("groupBy", v)}
          />
        </div>
      </div>

      <div className="sidebar__scroll">
        {sections.map((sec, i) => (
          <React.Fragment key={i}>
            {sec.kind === "needs" ? (
              <div className="section-head section-head--needs">
                <span className="section-head__label">Needs you</span>
                <span className="section-head__count">
                  ({sec.items.length})
                </span>
              </div>
            ) : sec.kind === "session" ? (
              <SessionGroupHeader sessionName={sec.name} items={sec.items} />
            ) : (
              <ProjectGroupHeader projectName={sec.name} items={sec.items} />
            )}
            {sec.items.map((c) => (
              <ConvRow
                key={c.id}
                conv={c}
                current={c.id === currentId}
                density={density}
                showSparkline={showSparkline}
                showSession={showSession && sec.kind !== "session"}
                sessionGroupPos={c._pos}
                onClick={(e) => onPeek(c, e.currentTarget)}
                onContextMenu={(e) => onContext(c, e)}
              />
            ))}
          </React.Fragment>
        ))}
        {sections.length === 0 && (
          <div
            style={{
              padding: 24,
              fontSize: 12,
              color: "var(--text-tertiary)",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
            }}
          >
            No conversations match.
          </div>
        )}
      </div>
    </aside>
  );
};

const ProjectGroupHeader = ({ projectName, items }) => (
  <div className="section-head__group">
    <span>{projectName}</span>
    <span className="repo">· {items.length}</span>
  </div>
);

// Two-segment group-by switch.
// Sits in its own row in the sidebar head and mirrors the Tweaks-panel value.
const GroupBySwitch = ({ value, onChange }) => (
  <div
    className="group-by"
    role="radiogroup"
    aria-label="Group conversations by"
  >
    <button
      role="radio"
      aria-checked={value === "project"}
      className={"group-by__seg" + (value === "project" ? " active" : "")}
      onClick={() => onChange("project")}
      title="Group by project"
    >
      <GroupIconFolder />
      <span>Project</span>
    </button>
    <button
      role="radio"
      aria-checked={value === "session"}
      className={"group-by__seg" + (value === "session" ? " active" : "")}
      onClick={() => onChange("session")}
      title="Group by session"
    >
      <GroupIconBranch />
      <span>Session</span>
    </button>
  </div>
);

const GroupIconFolder = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);
const GroupIconBranch = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="4" cy="13" r="1.4" />
      <circle cx="12" cy="6" r="1.4" />
      <path d="M4 4.4v7.2M4 8h5a3 3 0 0 0 3-3V7.4" />
    </g>
  </svg>
);

const SessionGroupHeader = ({ sessionName, items }) => {
  const project = items[0]?.project;
  return (
    <div className="section-head__group section-head__group--session">
      <span className="proj">{project}</span>
      <span className="sep">/</span>
      <span className="sess">{sessionName}</span>
      {items.length > 1 && <span className="repo">· {items.length}</span>}
    </div>
  );
};

Object.assign(window, { Sidebar });
