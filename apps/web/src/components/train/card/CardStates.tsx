import { useCopy } from "@gerlines/i18n/react";
import { Button, Notice, Skeleton } from "@gerlines/ui";
import { CircleAlert, RotateCw, TrainFront } from "lucide-react";
import type { ReactNode } from "react";

export function CardLoading({ closeSlot, peek }: { closeSlot: ReactNode; peek: boolean }) {
  const train = useCopy().train;
  return (
    <div aria-busy="true" className="flex flex-col gap-3 pb-4">
      <p role="status" className="sr-only">
        {train.loading}
      </p>
      <div className="flex min-h-target items-center justify-between px-4">
        <Skeleton className="h-4 w-28" />
        {closeSlot}
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-3 px-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="col-span-2 h-5 w-56" />
      </div>
      <div className="grid grid-cols-[28px_1fr_auto] items-center gap-x-2 gap-y-4 px-4 pt-2">
        <Skeleton className="size-3.5 justify-self-center rounded-full" />
        <Skeleton className="h-4 w-24" />
        <span />
        <Skeleton className="size-5 justify-self-center rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-5 w-36" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      {peek ? null : <Skeleton className="mx-4 mt-2 h-target" />}
    </div>
  );
}

export function CardMessage({
  closeSlot,
  kind,
  onRetry,
}: {
  closeSlot: ReactNode;
  kind: "not-found" | "error";
  onRetry?: () => void;
}) {
  const copy = useCopy();
  const train = useCopy().train;
  return (
    <div className="flex flex-col gap-3 pb-4">
      <div className="flex min-h-target items-center justify-between px-4">
        <span className="type-label text-ink-muted">{copy.card.label}</span>
        {closeSlot}
      </div>
      <div className="flex flex-col items-start gap-3 px-4">
        {kind === "error" ? (
          <>
            <Notice tone="error" role="alert" icon={<CircleAlert />} className="self-stretch">
              {train.loadError}
            </Notice>
            {onRetry ? (
              <Button variant="secondary" onClick={onRetry}>
                <RotateCw aria-hidden="true" />
                {train.retry}
              </Button>
            ) : null}
          </>
        ) : (
          <Notice role="status" icon={<TrainFront />} className="self-stretch">
            {copy.card.ended}
          </Notice>
        )}
      </div>
    </div>
  );
}
