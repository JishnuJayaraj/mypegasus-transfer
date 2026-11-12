import type { ReactNode } from "react";

export interface Fact {
  label: string;
  /** Nothing (`null`, `undefined`, an empty string) is shown as a dash, never as a gap. */
  value: ReactNode;
}

const NONE = "–";

/**
 * Label and value pairs (ui-patterns.md, which pattern): a definition list in a two- or
 * four-column grid, the label beside its value or above it. One column at 400 % zoom.
 */
export function Facts({
  items,
  columns = 2,
  labels = "beside",
}: {
  items: Fact[];
  columns?: 2 | 4;
  labels?: "beside" | "above";
}) {
  return (
    <dl className={`tp-fact-grid tp-fact-grid--${columns} tp-fact-grid--${labels}`}>
      {items.map(({ label, value }) => (
        <div key={label} className="tp-fact">
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === "" ? NONE : value}</dd>
        </div>
      ))}
    </dl>
  );
}
