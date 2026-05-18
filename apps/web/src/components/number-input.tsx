import type { ComponentProps, KeyboardEvent } from "react";

import { Input } from "~/components/input";

// A digit-only text input with keyboard arrow control. Behaves like a
// regular text input for selection (double-click selects all, etc.) but
// rejects non-digit characters on type and bumps the value on Up/Down.
// Use instead of `<input type="number">` when you want the validation and
// keyboard increment but not the spinner controls.
type NumberInputProps = Omit<ComponentProps<"input">, "type" | "value" | "onChange"> & {
  value: string;
  onChange: (next: string) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
};

export function NumberInput({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  onKeyDown,
  onBlur,
  ...rest
}: NumberInputProps) {
  const clamp = (n: number): number => {
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };
  const bump = (delta: number) => {
    const current = value === "" ? 0 : Number(value);
    if (!Number.isFinite(current)) return;
    onChange(String(clamp(current + delta)));
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      bump(step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      bump(-step);
    } else if (e.key === "Enter") {
      e.preventDefault();
      onCommit?.();
    }
    onKeyDown?.(e);
  };
  return (
    <Input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      onBlur={(e) => {
        onCommit?.();
        onBlur?.(e);
      }}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}
