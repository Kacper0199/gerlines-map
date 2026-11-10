import { copyFor } from "@gerlines/i18n";
import { Link2, LocateFixed, Route, Share2, X } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "../../src/index.ts";
import { Section, Specimen } from "../layout.tsx";
import type { SheetStrings } from "../strings.ts";

type Variant = "selection" | "solid" | "secondary" | "quiet";

const VARIANTS: readonly Variant[] = ["selection", "solid", "secondary", "quiet"];

const FORCED: Readonly<Record<Variant, Readonly<Record<"hover" | "active", string>>>> = {
  selection: { hover: "bg-selection-hover", active: "translate-y-px bg-selection-active" },
  solid: { hover: "bg-ink/85", active: "translate-y-px bg-ink/75" },
  secondary: { hover: "bg-raised-hover", active: "translate-y-px bg-raised-hover" },
  quiet: { hover: "bg-raised text-ink", active: "translate-y-px bg-raised text-ink" },
};

const FOCUS_CLASS = "outline-2 outline-offset-2 outline-focus";

function stateClass(variant: Variant, state: string): string | undefined {
  if (state === "hover" || state === "active") {
    return FORCED[variant][state];
  }
  return state === "focus" ? FOCUS_CLASS : undefined;
}

const STATES = ["default", "hover", "focus", "active", "disabled", "loading"] as const;

export function Actions({ strings }: { strings: SheetStrings }) {
  const [pending, setPending] = useState(false);
  const icons: Readonly<Record<Variant, typeof LocateFixed>> = {
    selection: LocateFixed,
    solid: Link2,
    secondary: Route,
    quiet: Share2,
  };
  const labels: Readonly<Record<Variant, string>> = {
    selection: strings.follow,
    solid: strings.confirm,
    secondary: strings.route,
    quiet: strings.share,
  };
  return (
    <Section
      id="buttons"
      title="Buttons"
      note="Amber belongs to the selection, so the selection button is only for Follow type actions. Hover, focus and active are forced here so every state is visible at once."
    >
      <div className="overflow-x-auto">
        <table className="type-body w-full min-w-[640px] border-separate border-spacing-y-3">
          <thead>
            <tr className="type-label text-left text-ink-muted">
              <th scope="col" className="pr-3 font-semibold">
                Variant
              </th>
              {STATES.map((state) => (
                <th key={state} scope="col" className="pr-3 font-semibold">
                  {state}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VARIANTS.map((variant) => {
              const Icon = icons[variant];
              return (
                <tr key={variant}>
                  <th scope="row" className="type-label pr-3 text-left">
                    {variant}
                  </th>
                  {STATES.map((state) => (
                    <td key={state} className="pr-3">
                      <Button
                        variant={variant}
                        disabled={state === "disabled"}
                        loading={state === "loading"}
                        className={stateClass(variant, state)}
                      >
                        <Icon aria-hidden="true" />
                        {labels[variant]}
                      </Button>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <Specimen label="Icon buttons with tooltip">
          <IconButton label={strings.close} tooltip>
            <X aria-hidden="true" />
          </IconButton>
          <IconButton label={strings.share} variant="secondary" tooltip>
            <Share2 aria-hidden="true" />
          </IconButton>
          <IconButton label={strings.follow} variant="selection" tooltip>
            <LocateFixed aria-hidden="true" />
          </IconButton>
        </Specimen>
        <Specimen label="Loading on demand">
          <Button
            variant="secondary"
            loading={pending}
            onClick={() => {
              setPending(true);
              window.setTimeout(() => setPending(false), 1600);
            }}
          >
            {strings.confirm}
          </Button>
        </Specimen>
        <Specimen label="Longest messages of each language on a button">
          {(["en", "de", "pl"] as const).map((locale) => (
            <Button key={locale} variant="secondary" lang={locale}>
              {copyFor(locale).live.errors.unreadable}
            </Button>
          ))}
        </Specimen>
      </div>
    </Section>
  );
}
