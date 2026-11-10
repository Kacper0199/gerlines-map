import { useCopy } from "@gerlines/i18n/react";
import { Card } from "@gerlines/ui";
import type { ReactNode } from "react";
import { SearchBox } from "../../search/SearchBox.tsx";
import { ColourModeTabs } from "./ColourModeTabs.tsx";

function SearchInput({ endSlot }: { endSlot?: ReactNode }) {
  const { search, searchField } = useCopy();
  return (
    <SearchBox
      placeholder={[
        search.placeholder,
        searchField.placeholderMedium,
        search.placeholderShort,
        searchField.placeholderTiny,
      ]}
      endSlot={endSlot}
    />
  );
}

export function SearchCard({
  compact = false,
  endSlot,
}: {
  compact?: boolean;
  endSlot?: ReactNode;
}) {
  const copy = useCopy();
  return (
    <Card
      className="pointer-events-auto gap-3 max-[640px]:gap-1 max-[640px]:py-3"
      data-slot="search-card"
    >
      <div className="px-4">
        {compact ? (
          <h1 className="type-wordmark mb-2">{copy.brand.name}</h1>
        ) : (
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h1 className="type-wordmark">{copy.brand.name}</h1>
            <p className="type-label font-normal text-ink-muted">{copy.brand.tagline}</p>
          </div>
        )}
        <SearchInput endSlot={endSlot} />
      </div>
      <div className="px-4">
        <ColourModeTabs />
      </div>
    </Card>
  );
}
