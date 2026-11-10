import { type ReactNode, useId } from "react";

/** A label tied to its control by id, with the control's props given the id. */
export function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="type-label">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
