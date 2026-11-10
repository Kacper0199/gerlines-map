import { useCopy } from "@gerlines/i18n/react";
import { BottomSheet, IconButton } from "@gerlines/ui";
import { X } from "lucide-react";
import { CardLoading } from "./CardStates.tsx";

export function CardFallback({ phone, onClose }: { phone: boolean; onClose: () => void }) {
  const copy = useCopy();
  const close = (
    <IconButton label={copy.card.close} onClick={onClose}>
      <X aria-hidden="true" />
    </IconButton>
  );
  if (phone) {
    return (
      <BottomSheet
        label={copy.card.label}
        expandLabel={copy.card.expand}
        collapseLabel={copy.card.collapse}
        trailing={close}
        className="pointer-events-auto z-20"
      >
        <CardLoading closeSlot={null} peek />
      </BottomSheet>
    );
  }
  return (
    <article
      aria-label={copy.card.label}
      className="card-surface pointer-events-auto flex min-h-0 flex-col pt-2"
    >
      <CardLoading closeSlot={<div className="-mr-3">{close}</div>} peek={false} />
    </article>
  );
}
