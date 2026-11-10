import { useLegalCopy } from "@gerlines/i18n/legal";

export function NotAffiliated() {
  const text = useLegalCopy().legal;
  return (
    <section
      aria-labelledby="not-affiliated-title"
      className="flex max-w-[75ch] flex-col gap-1 rounded-lg border border-hairline bg-raised px-4 py-3"
    >
      <h2 id="not-affiliated-title" className="type-body-strong">
        {text.notAffiliatedTitle}
      </h2>
      <p className="type-body">{text.notAffiliated}</p>
    </section>
  );
}
