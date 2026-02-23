"use client";

import { useState, useCallback, useMemo } from "react";
import type { AskQuestionItem } from "@/types";

interface AskQuestionPanelProps {
  questions: AskQuestionItem[];
  questionId: string;
  currentIndex: number;
  onNavigate: (index: number) => void;
  onSubmit: (questionId: string, answers: Record<string, string>) => void;
  disabled?: boolean;
}

export default function AskQuestionPanel({
  questions,
  questionId,
  currentIndex,
  onNavigate,
  onSubmit,
  disabled = false,
}: AskQuestionPanelProps) {
  // Track selections per question (keyed by question text)
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const [useOther, setUseOther] = useState<Record<string, boolean>>({});

  const current = questions[currentIndex];
  const totalQuestions = questions.length;
  const isMultiQuestion = totalQuestions > 1;

  // Derive current question's state
  const currentSelections = useMemo(
    () =>
      current
        ? (selections[current.question] ?? new Set<string>())
        : new Set<string>(),
    [selections, current],
  );
  const currentOtherText = current ? (otherTexts[current.question] ?? "") : "";
  const currentUseOther = current
    ? (useOther[current.question] ?? false)
    : false;

  const toggleOption = useCallback(
    (label: string) => {
      if (!current) return;
      setSelections((prev) => {
        const key = current.question;
        const existing = prev[key] ?? new Set<string>();
        const next = new Set(existing);

        if (current.multiSelect) {
          if (next.has(label)) next.delete(label);
          else next.add(label);
        } else {
          next.clear();
          next.add(label);
        }

        // Clear "other" when selecting a predefined option (single-select only)
        if (!current.multiSelect) {
          setUseOther((p) => ({ ...p, [key]: false }));
        }

        return { ...prev, [key]: next };
      });
    },
    [current],
  );

  const toggleOther = useCallback(() => {
    if (!current) return;
    const key = current.question;
    setUseOther((prev) => {
      const next = !prev[key];
      if (next && !current.multiSelect) {
        // Single select: clear predefined selections
        setSelections((p) => ({ ...p, [key]: new Set<string>() }));
      }
      return { ...prev, [key]: next };
    });
  }, [current]);

  const handleOtherTextChange = useCallback(
    (text: string) => {
      if (!current) return;
      setOtherTexts((prev) => ({ ...prev, [current.question]: text }));
    },
    [current],
  );

  // Check if a single question has at least one answer
  const isQuestionAnswered = useCallback(
    (q: AskQuestionItem) => {
      const sel = selections[q.question];
      const hasSelection = sel && sel.size > 0;
      const hasOther =
        useOther[q.question] &&
        (otherTexts[q.question] ?? "").trim().length > 0;
      return hasSelection || hasOther;
    },
    [selections, useOther, otherTexts],
  );

  // Check if all questions have at least one answer
  const allAnswered = useMemo(() => {
    return questions.every(isQuestionAnswered);
  }, [questions, isQuestionAnswered]);

  const isLastQuestion = currentIndex === totalQuestions - 1;
  const currentAnswered = current ? isQuestionAnswered(current) : false;

  const handleSubmit = useCallback(() => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const sel = selections[q.question] ?? new Set<string>();
      const isOther = useOther[q.question];
      const otherText = (otherTexts[q.question] ?? "").trim();

      if (isOther && otherText) {
        if (q.multiSelect && sel.size > 0) {
          // Multi-select with other: join all labels + other text
          answers[q.question] = [...Array.from(sel), otherText].join(", ");
        } else {
          answers[q.question] = otherText;
        }
      } else if (q.multiSelect) {
        answers[q.question] = Array.from(sel).join(", ");
      } else {
        answers[q.question] = Array.from(sel)[0] ?? "";
      }
    }
    onSubmit(questionId, answers);
  }, [questions, selections, useOther, otherTexts, questionId, onSubmit]);

  if (!current) return null;

  return (
    <div className="ask-question-panel">
      <div className="ask-question-header">
        <div className="ask-question-badge">Claude needs your input</div>
        {isMultiQuestion && (
          <div className="ask-question-nav">
            <button
              className="ask-question-nav-btn"
              disabled={currentIndex === 0}
              onClick={() => onNavigate(currentIndex - 1)}
              aria-label="Previous question"
            >
              &#8592;
            </button>
            <span className="ask-question-counter">
              {currentIndex + 1} / {totalQuestions}
            </span>
            <button
              className="ask-question-nav-btn"
              disabled={currentIndex === totalQuestions - 1}
              onClick={() => onNavigate(currentIndex + 1)}
              aria-label="Next question"
            >
              &#8594;
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
            className={`ask-question-option${currentSelections.has(opt.label) ? " selected" : ""}`}
          >
            <input
              type={current.multiSelect ? "checkbox" : "radio"}
              name={`question-${currentIndex}`}
              checked={currentSelections.has(opt.label)}
              onChange={() => toggleOption(opt.label)}
              disabled={disabled}
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

        {/* "Other" free-text option */}
        <label
          className={`ask-question-option${currentUseOther ? " selected" : ""}`}
        >
          <input
            type={current.multiSelect ? "checkbox" : "radio"}
            name={`question-${currentIndex}`}
            checked={currentUseOther}
            onChange={toggleOther}
            disabled={disabled}
          />
          <div className="ask-question-option-content">
            <span className="ask-question-option-label">Other</span>
            {currentUseOther && (
              <input
                type="text"
                className="ask-question-other-input"
                placeholder="Type your answer..."
                value={currentOtherText}
                onChange={(e) => handleOtherTextChange(e.target.value)}
                autoFocus
                disabled={disabled}
              />
            )}
          </div>
        </label>
      </div>

      <div className="ask-question-actions">
        {isMultiQuestion && !isLastQuestion ? (
          <button
            className="ask-question-submit"
            disabled={disabled || !currentAnswered}
            onClick={() => onNavigate(currentIndex + 1)}
          >
            Next Question &#8594;
          </button>
        ) : (
          <button
            className="ask-question-submit"
            disabled={disabled || !allAnswered}
            onClick={handleSubmit}
          >
            {isMultiQuestion ? "Submit All Answers" : "Submit Answer"}
          </button>
        )}
      </div>
    </div>
  );
}
