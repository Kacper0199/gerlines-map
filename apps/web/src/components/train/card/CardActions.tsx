import { useCopy } from "@gerlines/i18n/react";
import { Button, cn } from "@gerlines/ui";
import { Check, LocateFixed, Route, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ShareOutcome = "shared" | "copied" | "failed";

export interface TrainActionHandlers {
  readonly following?: boolean;
  readonly onFollowChange?: (following: boolean) => void;
  readonly onRoute?: () => void;
  readonly onShare?: () => Promise<ShareOutcome>;
}

const FEEDBACK_MS = 2500;

export function CardActions({
  onMap,
  handlers,
  className,
}: {
  onMap: boolean;
  handlers: TrainActionHandlers;
  className?: string;
}) {
  const train = useCopy().train;
  const [feedback, setFeedback] = useState<ShareOutcome | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function share() {
    if (!handlers.onShare) {
      return;
    }
    const outcome = await handlers.onShare();
    setFeedback(outcome);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }

  const following = handlers.following ?? false;
  return (
    <div className={cn("flex flex-col gap-1 px-4", className)}>
      <div className="flex gap-2">
        {onMap && handlers.onFollowChange ? (
          <Button
            variant="selection"
            className="min-w-0 flex-1 aria-pressed:bg-selection-active"
            aria-pressed={following}
            onClick={() => handlers.onFollowChange?.(!following)}
          >
            {following ? <Check aria-hidden="true" /> : <LocateFixed aria-hidden="true" />}
            {train.follow}
          </Button>
        ) : null}
        {onMap && handlers.onRoute ? (
          <Button
            variant="secondary"
            className="min-w-0 flex-1"
            onClick={() => handlers.onRoute?.()}
          >
            <Route aria-hidden="true" />
            {train.route}
          </Button>
        ) : null}
        <Button variant="secondary" className="min-w-0 flex-1" onClick={() => void share()}>
          {feedback === "copied" ? <Check aria-hidden="true" /> : <Share2 aria-hidden="true" />}
          {feedback === "copied" ? train.shareCopied : train.share}
        </Button>
      </div>
      <p
        role="status"
        className={cn(
          "type-caption items-center gap-1.5 text-ink",
          feedback === "failed" ? "flex" : "sr-only",
        )}
      >
        {feedback === "failed" ? (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-error" />
        ) : null}
        {feedback === "copied" ? train.shareCopied : feedback === "failed" ? train.shareFailed : ""}
      </p>
    </div>
  );
}
