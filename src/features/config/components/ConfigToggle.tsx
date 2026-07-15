import { Switch } from "@/components/ui/Switch";

// Config-page on/off row: the shared Radix Switch primitive plus this domain's
// ON/OFF caption. The switch's role/aria/keyboard/disabled behaviour lives in
// the primitive; this wrapper owns the caption, the right-aligned row layout,
// and the accessible naming. The visible ON/OFF caption is not a meaningful
// name, so the field's descriptive label (passed by ConfigField's caller) names
// the switch via aria-label. The <label> makes the whole row — switch and
// caption — a single click target: a native label forwards presses to its one
// labelable control (the Radix switch button).
export function ConfigToggle({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ml-auto inline-flex w-fit cursor-pointer items-center gap-sm font-mono text-[0.72rem] font-semibold tracking-[0.06em] text-text-secondary uppercase">
      <Switch
        aria-label={label}
        checked={value}
        onCheckedChange={onChange}
        disabled={disabled}
      />
      <span>{value ? "ON" : "OFF"}</span>
    </label>
  );
}
