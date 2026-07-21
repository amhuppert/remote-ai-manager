import { useId, useState } from "react";
import { FormError, FormInput } from "@/components/ui/FormField";
import {
  msToMinutes,
  minutesToMs,
  validateNumericInput,
} from "../config-helpers";

export function ConfigNumericInput({
  value,
  onChange,
  displayAsMinutes,
  required,
  positive,
  integer,
  placeholder,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  onValidityChange,
  resetKey,
}: {
  value: number | null | undefined;
  onChange: (v: number | null | undefined) => void;
  displayAsMinutes?: boolean;
  required?: boolean;
  positive?: boolean;
  integer?: boolean;
  placeholder?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  onValidityChange?: (valid: boolean) => void;
  resetKey?: unknown;
}) {
  const toDisplay = (v: number | null | undefined): string => {
    if (v == null) return "";
    return String(displayAsMinutes ? msToMinutes(v) : v);
  };

  const [localStr, setLocalStr] = useState(() => toDisplay(value));
  const [error, setError] = useState<string | null>(null);
  const [prevValue, setPrevValue] = useState(value);
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  const errorId = useId();

  if (prevValue !== value || prevResetKey !== resetKey) {
    setPrevValue(value);
    setPrevResetKey(resetKey);
    setLocalStr(toDisplay(value));
    setError(null);
  }

  const handleInput = (text: string) => {
    setLocalStr(text);
    const result = validateNumericInput(text, { required, positive, integer });
    if (!result.valid) {
      setError(result.error ?? null);
      onValidityChange?.(false);
      return;
    }
    setError(null);
    onValidityChange?.(true);
    if (result.value === undefined) {
      onChange(undefined);
    } else {
      onChange(displayAsMinutes ? minutesToMs(result.value) : result.value);
    }
  };

  return (
    <>
      <FormInput
        type="text"
        inputMode="decimal"
        value={localStr}
        onChange={(e) => handleInput(e.target.value)}
        placeholder={placeholder}
        name={name}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [ariaDescribedBy, error ? errorId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        layoutClassName="max-768:min-h-[var(--touch-target-min)]"
      />
      {error && (
        <FormError id={errorId} role="alert">
          {error}
        </FormError>
      )}
    </>
  );
}
