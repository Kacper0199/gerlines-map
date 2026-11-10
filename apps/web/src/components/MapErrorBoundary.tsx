import { useCopy } from "@gerlines/i18n/react";
import { Button } from "@gerlines/ui";
import { Component, type ReactNode } from "react";
import { abandonEarlyWorker } from "../live/early-start.ts";

function reloadPage(): void {
  window.location.reload();
}

export function MapFailure({ onReload = reloadPage }: { onReload?: () => void }) {
  const { error } = useCopy().map;
  return (
    <div className="fixed inset-0 grid place-items-center bg-map-land p-6">
      <div
        role="alert"
        className="card-surface pointer-events-auto flex max-w-[360px] flex-col gap-3 p-4"
      >
        <h2 className="type-title">{error.title}</h2>
        <p className="type-body text-ink-muted">{error.body}</p>
        <Button variant="solid" className="self-start" onClick={onReload}>
          {error.reload}
        </Button>
      </div>
    </div>
  );
}

interface Props {
  readonly children: ReactNode;
  readonly onReload?: () => void;
}

export class MapErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    abandonEarlyWorker();
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return this.props.onReload ? <MapFailure onReload={this.props.onReload} /> : <MapFailure />;
    }
    return this.props.children;
  }
}
