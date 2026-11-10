import { SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../ui/input-group.tsx";

export interface SearchFieldProps {
  readonly label: string;
  readonly placeholder?: string;
  readonly clearLabel: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly trailing?: ReactNode;
  readonly onValueChange?: (value: string) => void;
  readonly className?: string;
}

export function SearchField({
  label,
  placeholder,
  clearLabel,
  value,
  defaultValue = "",
  invalid = false,
  describedBy,
  disabled = false,
  trailing,
  onValueChange,
  className,
}: SearchFieldProps) {
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const input = useRef<HTMLInputElement>(null);

  function update(next: string) {
    if (value === undefined) {
      setInner(next);
    }
    onValueChange?.(next);
  }

  return (
    <InputGroup
      className={cn(disabled && "has-disabled:opacity-100", className)}
      data-invalid={invalid ? "" : undefined}
    >
      <InputGroupAddon className={cn(disabled && "opacity-50")}>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        ref={input}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        disabled={disabled}
        value={current}
        onChange={(event) => update(event.currentTarget.value)}
        autoComplete="off"
        className="pl-10 text-ellipsis disabled:opacity-50 [&::-webkit-search-cancel-button]:hidden"
      />
      {current && !disabled ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={clearLabel}
            onClick={() => {
              update("");
              input.current?.focus();
            }}
          >
            <XIcon aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : trailing ? (
        <InputGroupAddon align="inline-end" className="pr-2">
          {trailing}
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
