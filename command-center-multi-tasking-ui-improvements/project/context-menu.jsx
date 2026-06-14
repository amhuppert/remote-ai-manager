// Right-click context menu for sidebar rows.

const ContextMenu = ({ x, y, items, onClose }) => {
  const ref = React.useRef(null);

  // Reposition if it would overflow the viewport.
  const [pos, setPos] = React.useState({ x, y });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x,
      ny = y;
    if (x + r.width > window.innerWidth - 8)
      nx = window.innerWidth - r.width - 8;
    if (y + r.height > window.innerHeight - 8)
      ny = window.innerHeight - r.height - 8;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  React.useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="ctx-menu__div" />
        ) : (
          <button
            key={i}
            className={"ctx-menu__item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onClick={() => {
              it.onSelect?.();
              onClose();
            }}
          >
            <span className="ctx-menu__label">{it.label}</span>
            {it.hotkey && <span className="ctx-menu__kbd">{it.hotkey}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
};

Object.assign(window, { ContextMenu });
