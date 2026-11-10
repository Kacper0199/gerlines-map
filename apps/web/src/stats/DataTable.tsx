import { cn } from "@gerlines/ui";

export function DataTable({
  caption,
  head,
  rows,
  className,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly string[])[];
  className?: string;
}) {
  return (
    <div className={cn("max-h-72 overflow-auto rounded-md border", className)}>
      <table className="type-data-small w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr>
            {head.map((name, index) => (
              <th
                key={name}
                scope="col"
                className={cn(
                  "type-caption border-b px-2 py-1.5 font-semibold text-ink-muted",
                  index > 0 && "text-right",
                )}
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells) => (
            <tr key={cells[0]} className="border-b last:border-b-0">
              {cells.map((cell, index) =>
                index === 0 ? (
                  <th
                    key={`${cells[0]}-${head[index]}`}
                    scope="row"
                    className="px-2 py-1 font-normal"
                  >
                    {cell}
                  </th>
                ) : (
                  <td key={`${cells[0]}-${head[index]}`} className="px-2 py-1 text-right">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
