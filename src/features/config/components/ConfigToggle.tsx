export function ConfigToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="config-toggle"
      onClick={() => !disabled && onChange(!value)}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onChange(!value);
        }
      }}
    >
      <div className={`config-toggle-track${value ? " active" : ""}`}>
        <div className="config-toggle-knob" />
      </div>
      <span className="config-toggle-label">{value ? "ON" : "OFF"}</span>
    </div>
  );
}
