// Root app — wires topbar, sidebar, conversation view, peek, context menu, tweaks.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
  enrichedSidebar: true,
  sidebarDensity: "preview",
  showSparkline: true,
  showNeedsYou: true,
  groupBy: "project",
  showTabs: true,
  showFleetCounter: true,
  paneSeparator: "shadow",
}; /*EDITMODE-END*/

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  const [layout, setLayout] = React.useState("default");
  const [currentId, setCurrentId] = React.useState("gc-multitasking");
  const [openTabs, setOpenTabs] = React.useState([
    "gc-multitasking",
    "ca-streaming",
    "ca-posthog",
    "ram-tests",
  ]);
  const [peek, setPeek] = React.useState(null); // { conv, anchor }
  const [ctxMenu, setCtxMenu] = React.useState(null); // { conv, x, y }
  const [sidebarFilter, setSidebarFilter] = React.useState("all"); // for ctx "filter to session"
  const [composerFocused, setComposerFocused] = React.useState(false);

  const all = window.MOCK.conversations;
  const byId = (id) => all.find((c) => c.id === id);
  const current = byId(currentId);

  const runningCount = all.filter((c) => c.status === "running").length;
  const needsCount = all.filter((c) => c.status === "waiting_for_input").length;
  const MAX_TABS = 6;
  const tabsAtCap = openTabs.length >= MAX_TABS;

  // Open peek / open full / pin tab / activate tab
  const openPeek = (conv, anchor) => setPeek({ conv, anchor });
  const closePeek = () => setPeek(null);

  const promoteToTab = (id) => {
    setOpenTabs((prev) => {
      if (prev.includes(id)) return prev;
      if (prev.length >= MAX_TABS) return prev; // capped
      return [...prev, id];
    });
    setCurrentId(id);
    setPeek(null);
  };
  const openFull = (id) => {
    setOpenTabs((prev) => {
      if (prev.includes(id)) return prev;
      if (prev.length >= MAX_TABS) return prev;
      return [...prev, id];
    });
    setCurrentId(id);
    setPeek(null);
  };
  const closeTab = (id) => {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t !== id);
      if (id === currentId && next.length) setCurrentId(next[0]);
      return next;
    });
  };
  const activateTab = (id) => {
    setCurrentId(id);
    setPeek(null);
  };

  // Cmd+1..9 swaps tabs; Cmd+T pins the peeked conv; Esc closes overlays / exits panes.
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key, 10) - 1;
        if (openTabs[idx]) {
          e.preventDefault();
          setCurrentId(openTabs[idx]);
          setPeek(null);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t" && peek) {
        e.preventDefault();
        promoteToTab(peek.conv.id);
      }
      if (e.key === "Escape") {
        if (peek) setPeek(null);
        else if (ctxMenu) setCtxMenu(null);
        else if (layout === "panes") setLayout("default");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTabs, peek, ctxMenu, layout]);

  // --- Right-click context menu wiring
  const openContext = (conv, e) => {
    e.preventDefault();
    setPeek(null);
    setCtxMenu({ conv, x: e.clientX, y: e.clientY });
  };
  const closeContext = () => setCtxMenu(null);

  const ctxItems = React.useMemo(() => {
    if (!ctxMenu) return [];
    const c = ctxMenu.conv;
    const inTabs = openTabs.includes(c.id);
    const isCurrent = c.id === currentId;
    return [
      {
        label: "Open conversation",
        hotkey: "↵",
        onSelect: () => openFull(c.id),
      },
      {
        label: inTabs
          ? "Already a tab"
          : tabsAtCap
            ? "Tab limit reached (6)"
            : "Pin as tab",
        hotkey: "⌘T",
        disabled: inTabs || tabsAtCap,
        onSelect: () => promoteToTab(c.id),
      },
      {
        label: "Peek",
        onSelect: () => {
          // Re-derive anchor from the row in the DOM
          const rows = [...document.querySelectorAll(".row")];
          const r = rows.find(
            (el) => el.querySelector(".row__title")?.textContent === c.title,
          );
          if (r) openPeek(c, r);
        },
      },
      { divider: true },
      {
        label: `Filter sidebar to session: ${c.session}`,
        onSelect: () => {
          // If user is asking to filter to a session that isn't the current convo's session,
          // we route via "session" filter — that filter shows convs in *current* convo's session.
          // For full flexibility, activate target conv first then enable the filter.
          if (!isCurrent) setCurrentId(c.id);
          setSidebarFilter("session");
        },
      },
      { label: "Open project page", onSelect: () => {} },
      {
        label: "Copy branch name",
        onSelect: () =>
          navigator.clipboard?.writeText(c.branch).catch(() => {}),
      },
      {
        label: "Copy context",
        hotkey: "⌘⇧C",
        onSelect: () => {
          const ctx = `# ${c.title}\nProject: ${c.project}\nSession: ${c.session}\nBranch: ${c.branch}\nStatus: ${c.status}\n\n${c.statusLine || ""}`;
          navigator.clipboard?.writeText(ctx).catch(() => {});
        },
      },
      { divider: true },
      { label: "Rename…", onSelect: () => {} },
      { label: "Archive conversation", onSelect: () => {} },
      { label: "Archive session", onSelect: () => {} },
    ];
  }, [ctxMenu, openTabs, currentId]);

  const tabConvs = openTabs.map(byId).filter(Boolean);

  return (
    <React.Fragment>
      <Topbar
        conv={current}
        layout={layout}
        setLayout={setLayout}
        runningCount={runningCount}
        needsCount={needsCount}
      />
      <div className="shell" data-layout={layout}>
        <Sidebar
          tweaks={tweaks}
          setTweak={setTweak}
          currentId={currentId}
          filter={sidebarFilter}
          setFilter={setSidebarFilter}
          onPeek={openPeek}
          onContext={openContext}
        />
        <div className="main">
          <div
            className={
              "content content--" + (layout === "panes" ? "panes" : "default")
            }
          >
            {layout === "panes" ? (
              <PanesView
                paneIds={openTabs}
                activeId={currentId}
                allConvs={all}
                composerFocused={composerFocused}
                paneSeparator={tweaks.paneSeparator}
                onActivate={(id) => setCurrentId(id)}
                onClose={closeTab}
                onOpenFull={(id) => {
                  setCurrentId(id);
                  setLayout("default");
                }}
                onContext={openContext}
              />
            ) : (
              <React.Fragment>
                <ConversationView
                  conv={current}
                  tabs={tabConvs}
                  currentId={currentId}
                  tweaks={tweaks}
                  onActivateTab={activateTab}
                  onCloseTab={closeTab}
                  atCap={tabsAtCap}
                />
                <RightPane conv={current} />
              </React.Fragment>
            )}
          </div>
          <GlobalComposer
            activeConv={current}
            onFocusChange={setComposerFocused}
          />
        </div>
      </div>

      {peek && (
        <PeekPopover
          anchor={peek.anchor}
          conv={peek.conv}
          onClose={closePeek}
          onPromote={promoteToTab}
          onOpenFull={openFull}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={closeContext}
        />
      )}

      <AppTweaksPanel tweaks={tweaks} setTweak={setTweak} />
    </React.Fragment>
  );
}

// --- Tweaks panel
const AppTweaksPanel = ({ tweaks, setTweak }) => {
  const { TweaksPanel, TweakSection, TweakToggle, TweakRadio, TweakSelect } =
    window;
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Enriched sidebar">
        <TweakToggle
          label="Enrich rows"
          value={tweaks.enrichedSidebar}
          onChange={(v) => setTweak("enrichedSidebar", v)}
        />
        <TweakRadio
          label="Density"
          value={tweaks.sidebarDensity}
          onChange={(v) => setTweak("sidebarDensity", v)}
          options={[
            { value: "compact", label: "Compact" },
            { value: "preview", label: "Preview" },
          ]}
        />
        <TweakToggle
          label="Sparkline"
          value={tweaks.showSparkline}
          onChange={(v) => setTweak("showSparkline", v)}
        />
        <TweakToggle
          label='"Needs you" group'
          value={tweaks.showNeedsYou}
          onChange={(v) => setTweak("showNeedsYou", v)}
        />
        <TweakRadio
          label="Group by"
          value={tweaks.groupBy}
          onChange={(v) => setTweak("groupBy", v)}
          options={[
            { value: "project", label: "Project" },
            { value: "session", label: "Session" },
          ]}
        />
      </TweakSection>

      <TweakSection label="Tabs strip">
        <TweakToggle
          label="Show tabs"
          value={tweaks.showTabs}
          onChange={(v) => setTweak("showTabs", v)}
        />
      </TweakSection>

      <TweakSection label="Topbar">
        <TweakToggle
          label="Fleet counter"
          value={tweaks.showFleetCounter}
          onChange={(v) => setTweak("showFleetCounter", v)}
        />
      </TweakSection>

      <TweakSection label="Panes">
        <TweakSelect
          label="Pane separator"
          value={tweaks.paneSeparator}
          onChange={(v) => setTweak("paneSeparator", v)}
          options={[
            { value: "ring", label: "Ring (border on each pane)" },
            { value: "gap", label: "Gap (wider gutter)" },
            { value: "shadow", label: "Shadow (raised cards)" },
            { value: "hairline", label: "Hairline (1px, original)" },
          ]}
        />
      </TweakSection>
    </TweaksPanel>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
