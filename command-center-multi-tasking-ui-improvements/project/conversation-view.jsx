// Tabs strip + conversation view (center pane).

const Tab = ({ conv, active, idx, onActivate, onClose }) => (
  <div
    className={"tab" + (active ? " active" : "")}
    onClick={() => onActivate(conv.id)}
    title={conv.title + " · " + conv.project}
  >
    <span
      className={"tab__dot row__dot--" + conv.status}
      style={{ width: 7, height: 7, borderRadius: "50%" }}
    />
    <span className="tab__title">{conv.title}</span>
    {idx < 9 && <span className="tab__hotkey">⌘{idx + 1}</span>}
    <button
      className="tab__close"
      onClick={(e) => {
        e.stopPropagation();
        onClose(conv.id);
      }}
      title="Close tab (does not end the agent)"
    >
      <Icon name="x" size={11} />
    </button>
  </div>
);

const TabsStrip = ({ tabs, currentId, onActivate, onClose, onNew, atCap }) => (
  <div className="tabs-strip" role="tablist">
    {tabs.map((c, i) => (
      <Tab
        key={c.id}
        conv={c}
        active={c.id === currentId}
        idx={i}
        onActivate={onActivate}
        onClose={onClose}
      />
    ))}
    <button
      className="tabs-strip__new"
      onClick={atCap ? undefined : onNew}
      disabled={atCap}
      title={
        atCap
          ? "Tab limit reached (6) — close a tab first"
          : "Pin another conversation as a tab"
      }
    >
      <Icon name="plus" size={13} />
    </button>
  </div>
);

const InfoStrip = ({ conv }) => (
  <div className="info-strip">
    <span className="info-strip__chip">
      <span className="label">Project</span>
      <b>{conv.project}</b>
    </span>
    <span className="info-strip__chip">
      <span className="label">Branch</span>
      <span className="branch">{conv.branch}</span>
    </span>
    <span className="info-strip__chip">
      <span className="label">Status</span>
      <span className={"peek__status peek__status--" + conv.status}>
        {conv.status === "running" && (
          <span className="row__dot row__dot--running" />
        )}
        {STATUS_LABEL[conv.status]}
      </span>
    </span>
    <span style={{ flex: 1 }} />
    <span className="info-strip__chip">
      <span className="label">Diff</span>
      <span style={{ color: "var(--green)" }}>+{conv.diff.add}</span>
      <span style={{ color: "var(--red)" }}>−{conv.diff.del}</span>
      <span style={{ color: "var(--text-tertiary)" }}>
        · {conv.diff.files} files
      </span>
    </span>
  </div>
);

const Message = ({ msg }) => (
  <div className={"msg msg--" + msg.role}>
    <div className="msg__avatar">{msg.role === "user" ? "You" : "CC"}</div>
    <div className="msg__body">
      <div className="msg__role">{msg.role === "user" ? "You" : "Claude"}</div>
      <div className="msg__text">
        {msg.text.split("\n\n").map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {msg.tool && (
        <div className="tool-call">
          <div className="tool-call__head">{msg.tool.name}</div>
          <code>{msg.tool.detail}</code>
        </div>
      )}
    </div>
  </div>
);

const Composer = () => {
  const [val, setVal] = React.useState("");
  return (
    <div className="composer">
      <div className="composer__box">
        <textarea
          placeholder="Send a prompt — ⌘⏎ to send, esc to cancel"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          rows={2}
        />
        <div className="composer__row">
          <span className="composer__meta">FAST mode · 5 reference docs</span>
          <button className="composer__send">
            <Icon name="send" size={11} />
            Send
            <span style={{ opacity: 0.7, marginLeft: 4 }}>⌘⏎</span>
          </button>
        </div>
      </div>
    </div>
  );
};

const ConversationView = ({
  conv,
  tabs,
  currentId,
  tweaks,
  onActivateTab,
  onCloseTab,
  atCap,
}) => {
  return (
    <section className="center">
      {tweaks.showTabs && tabs.length > 0 && (
        <TabsStrip
          tabs={tabs}
          currentId={currentId}
          onActivate={onActivateTab}
          onClose={onCloseTab}
          onNew={() => {}}
          atCap={atCap}
        />
      )}
      <InfoStrip conv={conv} />
      <div className="transcript">
        {window.MOCK.currentTranscript.map((m, i) => (
          <Message key={i} msg={m} />
        ))}
      </div>
    </section>
  );
};

// --- Right pane (Diff) — mostly chrome, plausible-looking content
const SAMPLE_DIFF_FILES = [
  { path: "src/components/Sidebar.tsx", add: 142, del: 18, active: true },
  { path: "src/components/PeekPopover.tsx", add: 96, del: 0 },
  { path: "src/components/TabsStrip.tsx", add: 54, del: 0 },
  { path: "src/components/InfoStrip.tsx", add: 12, del: 6 },
  { path: "styles/globals.css", add: 6, del: 22 },
  { path: "src/hooks/usePeek.ts", add: 38, del: 0 },
  { path: "src/lib/conv-status.ts", add: 14, del: 2 },
  { path: "src/App.tsx", add: 28, del: 0 },
];

const SAMPLE_DIFF = [
  { kind: "hunk", text: "@@ src/components/Sidebar.tsx @@" },
  { kind: "ctx", text: "export function Sidebar() {" },
  { kind: "ctx", text: "  const all = useConversations();" },
  { kind: "del", text: "  return (" },
  { kind: "del", text: '    <ul className="sidebar">' },
  { kind: "del", text: "      {all.map(c => (" },
  { kind: "del", text: "        <li key={c.id}>{c.title}</li>" },
  { kind: "del", text: "      ))}" },
  { kind: "del", text: "    </ul>" },
  { kind: "del", text: "  );" },
  {
    kind: "add",
    text: '  const [filter, setFilter] = useState<Filter>("all");',
  },
  { kind: "add", text: '  const [query, setQuery]   = useState("");' },
  { kind: "add", text: "" },
  { kind: "add", text: "  const visible = useMemo(() =>" },
  { kind: "add", text: "    applyFilters(all, filter, query)," },
  { kind: "add", text: "    [all, filter, query]" },
  { kind: "add", text: "  );" },
  { kind: "add", text: "" },
  { kind: "add", text: "  return (" },
  { kind: "add", text: '    <aside className="sidebar">' },
  {
    kind: "add",
    text: "      <SidebarHead {...{ filter, setFilter, query, setQuery }} />",
  },
  { kind: "add", text: "      <SidebarBody convs={visible} />" },
  { kind: "add", text: "    </aside>" },
  { kind: "add", text: "  );" },
  { kind: "ctx", text: "}" },
];

const RightPane = ({ conv }) => (
  <section className="rightpane">
    <div className="rightpane__head">
      <span>Diff</span>
      <span className="stat">
        <span className="add">+{conv.diff.add}</span>{" "}
        <span className="del">−{conv.diff.del}</span>{" "}
        <span style={{ color: "var(--text-tertiary)" }}>
          · {conv.diff.files} files
        </span>
      </span>
    </div>
    <div className="rightpane__files">
      {SAMPLE_DIFF_FILES.map((f, i) => (
        <div key={i} className={"diff-file" + (f.active ? " active" : "")}>
          <span className="path">{f.path}</span>
          <span className="add">+{f.add}</span>
          <span className="del">−{f.del}</span>
        </div>
      ))}
    </div>
    <div className="diff-content">
      {SAMPLE_DIFF.map((l, i) =>
        l.kind === "hunk" ? (
          <div key={i} className="diff-hunk">
            {l.text}
          </div>
        ) : (
          <div key={i} className={"diff-line " + l.kind}>
            {l.text}
          </div>
        ),
      )}
    </div>
  </section>
);

Object.assign(window, { ConversationView, RightPane });
