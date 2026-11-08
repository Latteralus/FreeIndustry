import { useId } from 'react';

/** A labelled drop-down list (filters, choices in forms). */

interface DropdownOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

export interface DropdownProps<Value extends string> {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly DropdownOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly disabled?: boolean;
  readonly id?: string;
}

export function Dropdown<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  id,
}: DropdownProps<Value>) {
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <span className="dropdown">
      <label htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const chosen = options.find((option) => option.value === event.target.value);
          if (chosen) {
            onChange(chosen.value);
          }
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
