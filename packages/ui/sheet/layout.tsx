import { Field } from "@base-ui/react/field";
import type { ReactNode } from "react";
import { cn } from "../src/index.ts";

export function Section({
  id,
  title,
  note,
  children,
  className,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("flex flex-col gap-4 border-t pt-6", className)}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="type-title">
          {title}
        </h2>
        {note ? <p className="type-body max-w-prose text-ink-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Specimen({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="type-label text-ink-muted">{label}</h3>
      <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>
    </div>
  );
}

export function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-6 sm:grid-cols-2 xl:grid-cols-3", className)}>{children}</div>
  );
}

export function LabelledRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Field.Root>
      <Field.Label className="type-body flex items-center gap-3">
        {children}
        {label}
      </Field.Label>
    </Field.Root>
  );
}
