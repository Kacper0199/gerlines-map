import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type NoticeTone = "neutral" | "error";

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly role?: "status" | "alert";
  readonly className?: string;
  readonly children: ReactNode;
}

export function Notice({ tone = "neutral", icon, action, role, className, children }: NoticeProps) {
  return (
    <div
      role={role}
      data-slot="notice"
      data-tone={tone}
      className={cn(
        "type-body flex items-start gap-2 rounded-lg border bg-raised px-3 py-2 text-ink",
        tone === "error" && "border-error",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex shrink-0 [&_svg]:size-4",
            tone === "error" ? "text-error" : "text-ink-muted",
          )}
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="-my-1 shrink-0">{action}</div> : null}
    </div>
  );
}
