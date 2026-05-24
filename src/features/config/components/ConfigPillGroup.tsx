export function ConfigPillGroup<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="config-pill-group">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`config-pill-btn${value === opt ? " active" : ""}`}
          onClick={() => !disabled && onChange(opt)}
          disabled={disabled}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
