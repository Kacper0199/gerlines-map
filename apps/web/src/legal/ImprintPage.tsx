import { useLegalCopy } from "@gerlines/i18n/legal";
import { Notice } from "@gerlines/ui";
import { FilePen } from "lucide-react";
import { LegalLayout, Missing } from "./LegalLayout.tsx";
import { NotAffiliated } from "./NotAffiliated.tsx";

/** The Impressum shell: every field the owner must provide is shown as missing, never invented (WP-9.6). */
export function ImprintPage() {
  const text = useLegalCopy().legal;
  const fields = [
    text.imprintName,
    text.imprintAddress,
    text.imprintEmail,
    text.imprintContact,
    text.imprintResponsible,
  ];
  return (
    <LegalLayout
      current="imprint"
      title={text.imprintTitle}
      intro={<p className="type-body text-ink-muted">{text.imprintIntro}</p>}
    >
      <Notice icon={<FilePen />} role="status" className="max-w-[65ch]">
        <p className="type-body-strong">{text.draftTitle}</p>
        <p>{text.imprintDraft}</p>
      </Notice>
      <dl className="grid max-w-[65ch] grid-cols-1 items-center gap-x-6 gap-y-3 sm:grid-cols-[auto_1fr]">
        {fields.map((field) => (
          <div key={field} className="contents">
            <dt className="type-label text-ink-muted">{field}</dt>
            <dd>
              <Missing />
            </dd>
          </div>
        ))}
      </dl>
      <NotAffiliated />
    </LegalLayout>
  );
}
