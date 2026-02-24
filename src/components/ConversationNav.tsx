interface ConversationNavProps {
  currentTurn: number;
  totalTurns: number;
  onFirst: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onLast: () => void;
}

export default function ConversationNav({
  currentTurn,
  totalTurns,
  onFirst,
  onPrevious,
  onNext,
  onLast,
}: ConversationNavProps) {
  const isEmpty = totalTurns === 0;

  return (
    <div className="msg-nav">
      <div className="msg-nav-group">
        <button className="nav-btn" onClick={onFirst} title="First message">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <line
              x1="2"
              y1="1.5"
              x2="8"
              y2="1.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M2 8L5 4L8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="nav-btn"
          onClick={onPrevious}
          title="Previous message"
        >
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 4.5L5 1.5L8.5 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <span className="msg-counter">
        {isEmpty ? "0 / 0" : `${currentTurn + 1} / ${totalTurns}`}
      </span>
      <div className="msg-nav-group">
        <button className="nav-btn" onClick={onNext} title="Next message">
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 1.5L5 4.5L8.5 1.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="nav-btn" onClick={onLast} title="Last message">
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2 2L5 6L8 2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="2"
              y1="8.5"
              x2="8"
              y2="8.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
