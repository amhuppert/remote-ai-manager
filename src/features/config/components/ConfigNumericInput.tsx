import { useState } from "react";
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
}: {
  value: number | null | undefined;
  onChange: (v: number | null | undefined) => void;
  displayAsMinutes?: boolean;
  required?: boolean;
  positive?: boolean;
  integer?: boolean;
  placeholder?: string;
}) {
  const toDisplay = (v: number | null | undefined): string => {
    if (v == null) return "";
    return String(displayAsMinutes ? msToMinutes(v) : v);
  };

  const [localStr, setLocalStr] = useState(() => toDisplay(value));
  const [error, setError] = useState<string | null>(null);
  const [prevValue, setPrevValue] = useState(value);

  if (prevValue !== value) {
    setPrevValue(value);
    setLocalStr(toDisplay(value));
    setError(null);
  }

  const handleInput = (text: string) => {
    setLocalStr(text);
    const result = validateNumericInput(text, { required, positive, integer });
    if (!result.valid) {
      setError(result.error ?? null);
      return;
    }
    setError(null);
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
      />
      {error && <FormError>{error}</FormError>}
    </>
  );
}
