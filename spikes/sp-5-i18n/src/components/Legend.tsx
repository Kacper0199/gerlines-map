import { CATEGORY_KEYS } from "@gerlines/i18n";
import { useCopy } from "@gerlines/i18n/react";
import { sample } from "../sample.ts";
import { Num } from "./Num.tsx";

const PLURAL_CHECK_COUNTS = [1, 2, 5, 22] as const;

export function Legend() {
  const copy = useCopy();
  return (
    <section className="card legend" aria-label={copy.legend.label}>
      <h2>{copy.legend.title}</h2>
      <dl className="totals">
        <div>
          <dt>{copy.legend.total}</dt>
          <dd>
            <Num value={sample.trainsTotal} />
          </dd>
        </div>
        <div>
          <dt>{copy.legend.realtime}</dt>
          <dd>
            <Num value={sample.trainsRealtime} />
          </dd>
        </div>
      </dl>
      <ul className="cats">
        {CATEGORY_KEYS.map((key) => (
          <li key={key}>
            <span className="swatch" data-cat={key} aria-hidden="true" />
            <span className="cat-name">{copy.categories[key].legend}</span>
            <Num value={sample.counts[key]} />
          </li>
        ))}
      </ul>
      <ul className="plural-check">
        {PLURAL_CHECK_COUNTS.map((count) => (
          <li key={count}>
            <Num value={count} /> {copy.legend.untracked(count)}
          </li>
        ))}
      </ul>
    </section>
  );
}
