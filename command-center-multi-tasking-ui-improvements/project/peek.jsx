// Peek-and-reply popover. Anchored to the right of the clicked sidebar row.
// Tails recent messages + lets you reply without leaving the current conversation.
//
// When the peeked conversation is waiting_for_input AND carries a structured
// pendingQuestion (the Ask-User-Question tool payload), the reply affordance is
// the real AskQuestionPanel UI — radio/checkbox options + "Other" + Submit —
// exactly as PromptInputSlot swaps it in for the composer in the live app.
// For every other status we fall back to status-aware quick replies + a textarea.

const QUICK_REPLIES = {
  running: ["Status?", "Pause", "Speed up"],
  awaiting: ["Continue", "Summarize", "Next task"],
  new: ["Kick off", "Outline plan first", "Hold"],
};

// Faithful prototype port of src/components/AskQuestionPanel.tsx.
const AskQuestionPanel = ({ questions, onSubmit }) => {
  const [index, setIndex] = React.useState(0);
  const [selections, setSelections] = React.useState({}); // { [questionText]: Set<label> }
  const [otherTexts, setOtherTexts] = React.useState({});
  const [useOther, setUseOther] = React.useState({});

  const current = questions[index];
  const total = questions.length;
  const isMulti = total > 1;
  const key = current.question;
  const sel = selections[key] || new Set();
  const otherText = otherTexts[key] || "";
  const isOther = !!useOther[key];

  const toggleOption = (label) => {
    setSelections((prev) => {
      const next = new Set(prev[key] || []);
      if (current.multiSelect) {
        next.has(label) ? next.delete(label) : next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return { ...prev, [key]: next };
    });
    if (!current.multiSelect) setUseOther((p) => ({ ...p, [key]: false }));
  };

  const toggleOther = () => {
    setUseOther((prev) => {
      const next = !prev[key];
      if (next && !current.multiSelect)
        setSelections((p) => ({ ...p, [key]: new Set() }));
      return { ...prev, [key]: next };
    });
  };

  const answered = (q) => {
    const s = selections[q.question];
    const hasSel = s && s.size > 0;
    const hasOther =
      useOther[q.question] && (otherTexts[q.question] || "").trim().length > 0;
    return hasSel || hasOther;
  };
  const allAnswered = questions.every(answered);
  const currentAnswered = answered(current);
  const isLast = index === total - 1;

  return (
    <div className="ask-question-panel">
      <div className="ask-question-header">
        <div className="ask-question-badge">Agent needs your input</div>
        {isMulti && (
          <div className="ask-question-nav">
            <button
              className="ask-question-nav-btn"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
              aria-label="Previous question"
            >
              ←
            </button>
            <span className="ask-question-counter">
              {index + 1} / {total}
            </span>
            <button
              className="ask-question-nav-btn"
              disabled={isLast}
              onClick={() => setIndex(index + 1)}
              aria-label="Next question"
            >
              →
            </button>
          </div>
        )}
      </div>

      {current.header && (
        <div className="ask-question-subheader">{current.header}</div>
      )}
      <div className="ask-question-text">{current.question}</div>

      <div className="ask-question-options">
        {current.options.map((opt) => (
          <label
            key={opt.label}
            className={
              "ask-question-option" + (sel.has(opt.label) ? " selected" : "")
            }
          >
            <input
              type={current.multiSelect ? "checkbox" : "radio"}
              name={"peek-q-" + index}
              checked={sel.has(opt.label)}
              onChange={() => toggleOption(opt.label)}
            />
            <div className="ask-question-option-content">
              <span className="ask-question-option-label">{opt.label}</span>
              {opt.description && (
                <span className="ask-question-option-desc">
                  {opt.description}
                </span>
              )}
            </div>
          </label>
        ))}

        <label className={"ask-question-option" + (isOther ? " selected" : "")}>
          <input
            type={current.multiSelect ? "checkbox" : "radio"}
            name={"peek-q-" + index}
            checked={isOther}
            onChange={toggleOther}
          />
          <div className="ask-question-option-content">
            <span className="ask-question-option-label">Other</span>
            {isOther && (
              <input
                type="text"
                className="ask-question-other-input"
                placeholder="Type your answer…"
                value={otherText}
                autoFocus
                onChange={(e) =>
                  setOtherTexts((p) => ({ ...p, [key]: e.target.value }))
                }
              />
            )}
          </div>
        </label>
      </div>

      <div className="ask-question-actions">
        {isMulti && !isLast ? (
          <button
            className="ask-question-submit"
            disabled={!currentAnswered}
            onClick={() => setIndex(index + 1)}
          >
            Next Question →
          </button>
        ) : (
          <button
            className="ask-question-submit"
            disabled={!allAnswered}
            onClick={onSubmit}
          >
            {isMulti ? "Submit All Answers" : "Submit Answer"}
          </button>
        )}
      </div>
    </div>
  );
};

const PeekPopover = ({ anchor, conv, onClose, onPromote, onOpenFull }) => {
  const peekRef = React.useRef(null);
  const [reply, setReply] = React.useState("");

  // Structured Ask-User-Question payload, only when the agent is actually blocked on input.
  const pending =
    conv.status === "waiting_for_input" && Array.isArray(conv.pendingQuestion)
      ? conv.pendingQuestion
      : null;

  // Position the popover relative to the anchor element.
  const [pos, setPos] = React.useState({ left: 320 + 12, top: 100 });
  React.useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const W = 460;
    const H = 620;
    let left = r.right + 8;
    let top = r.top - 40;
    if (left + W > window.innerWidth - 12) left = window.innerWidth - W - 12;
    if (top + H > window.innerHeight - 12) top = window.innerHeight - H - 12;
    if (top < 12) top = 12;
    setPos({ left, top });
  }, [anchor]);

  // Esc closes; focus the input on mount. ⌘⏎ sends from the free-text path only.
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        if (!pending && reply.trim()) onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reply, pending]);

  const messages = window.MOCK.peekTranscripts[conv.id] || [];
  const quick = pending ? [] : QUICK_REPLIES[conv.status] || [];

  // Fallback amber banner — only when waiting_for_input WITHOUT a structured question.
  const banner =
    conv.status === "waiting_for_input" && !pending
      ? conv.awaitingQuestion
      : null;

  return ReactDOM.createPortal(
    <React.Fragment>
      <div className="peek-backdrop" onClick={onClose} />
      <div
        ref={peekRef}
        className={"peek" + (pending ? " peek--asking" : "")}
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="peek__head">
          <div className="peek__top">
            <span className={"row__dot row__dot--" + conv.status} />
            <span className="peek__title">{conv.title}</span>
            <button
              className="peek__btn peek__btn--primary"
              onClick={() => onOpenFull(conv.id)}
              title="Open the full conversation page (this also pins it as a tab)"
            >
              Open conversation
              <Icon name="openExternal" size={11} />
            </button>
            <button
              className="peek__close"
              onClick={onClose}
              title="Close (esc)"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="peek__meta">
            <span className={"peek__status peek__status--" + conv.status}>
              {STATUS_LABEL[conv.status]}
            </span>
            <span>·</span>
            <span>
              <b>{conv.project}</b>
            </span>
            <span>·</span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
            >
              <Icon name="branch" size={10} /> {conv.session}
            </span>
            <span>·</span>
            <span>{conv.timeLabel}</span>
          </div>
        </header>

        <div className="peek__body">
          {banner && (
            <div className="peek__awaiting">
              <span className="label">Agent is asking</span>
              <span>"{banner}"</span>
            </div>
          )}
          {messages.length === 0 ? (
            <div
              style={{
                color: "var(--text-tertiary)",
                fontSize: 12,
                padding: 24,
                textAlign: "center",
              }}
            >
              No messages yet.
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className="peek__msg">
                <Message msg={m} />
              </div>
            ))
          )}
        </div>

        {pending ? (
          // Mirrors PromptInputSlot: the Ask-User-Question UI replaces the composer.
          <AskQuestionPanel questions={pending} onSubmit={onClose} />
        ) : (
          <div className="peek__composer">
            {quick.length > 0 && (
              <div className="peek__quick">
                {quick.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => setReply(reply ? reply + " " + q : q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            <div className="peek__composer-box">
              <textarea
                autoFocus
                placeholder="Reply without leaving — ⌘⏎ to send"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
              />
              <div className="peek__composer-row">
                <span>
                  <span className="kbd">esc</span> close
                </span>
                <span>
                  <span className="kbd">⌘T</span> pin as tab
                </span>
                <button className="peek__send">
                  <Icon name="send" size={10} />
                  Send
                  <span style={{ opacity: 0.7, marginLeft: 4 }}>⌘⏎</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </React.Fragment>,
    document.body,
  );
};

Object.assign(window, { PeekPopover });
