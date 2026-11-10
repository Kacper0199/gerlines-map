import type { ShareOutcome } from "./CardActions.tsx";

export const TRAIN_PARAM = "train";

export function trainShareUrl(
  tripInstanceId: string,
  location: Pick<Location, "origin" | "pathname" | "search">,
): string {
  const params = new URLSearchParams(location.search);
  params.set(TRAIN_PARAM, tripInstanceId);
  return `${location.origin}${location.pathname}?${params.toString()}`;
}

export interface ShareTarget {
  readonly share?: (data: ShareData) => Promise<void>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly prefersSheet: boolean;
}

export async function shareLink(
  url: string,
  title: string,
  target: ShareTarget,
): Promise<ShareOutcome> {
  if (target.prefersSheet && target.share) {
    try {
      await target.share({ url, title });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "shared";
      }
    }
  }
  try {
    if (!target.clipboard) {
      return "failed";
    }
    await target.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

export function browserShareTarget(): ShareTarget {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return {
    ...(typeof navigator.share === "function"
      ? { share: (data: ShareData) => navigator.share(data) }
      : {}),
    ...(navigator.clipboard ? { clipboard: navigator.clipboard } : {}),
    prefersSheet: coarse,
  };
}
