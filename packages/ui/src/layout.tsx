import { useId, type ReactNode } from "react";

// Layout primitives (ui-patterns.md, principle 8): spacing and columns come from here, never from
// a class named for something else. Logical properties only, so RTL works.

type HeadingLevel = 2 | 3;

function Heading({
  level,
  id,
  children,
}: {
  level: HeadingLevel;
  id: string;
  children: ReactNode;
}) {
  return level === 2 ? <h2 id={id}>{children}</h2> : <h3 id={id}>{children}</h3>;
}

interface BlockProps {
  /** The heading; the region is labelled by it. */
  title: string;
  /** `h2` on a page, `h3` inside a section or a tab panel that already has its heading. */
  level?: HeadingLevel;
  description?: ReactNode;
  /** Actions for this block only, at the end of its header. */
  actions?: ReactNode;
  children?: ReactNode;
  /** The block's own id, for an in-page link to it ("#project-import"). */
  id?: string;
}

function BlockHeader({
  id,
  title,
  level,
  description,
  actions,
  prefix,
}: Omit<BlockProps, "id"> & { id: string; level: HeadingLevel; prefix: string }) {
  return (
    <div className={`${prefix}-header`}>
      <div className={`${prefix}-heading`}>
        <Heading level={level} id={id}>
          {title}
        </Heading>
        {description && <div className={`${prefix}-description`}>{description}</div>}
      </div>
      {actions && <div className={`${prefix}-actions`}>{actions}</div>}
    </div>
  );
}

/** A titled part of a page: a heading, an optional description and actions, then the body. */
export function Section({
  title,
  level = 2,
  description,
  actions,
  children,
  id: anchor,
}: BlockProps) {
  const id = useId();
  return (
    <section id={anchor} className="tp-section" aria-labelledby={id}>
      <BlockHeader
        id={id}
        title={title}
        level={level}
        description={description}
        actions={actions}
        prefix="tp-section"
      />
      {children}
    </section>
  );
}

/** A bordered block on the layer colour, for one topic (e.g. an appointment's details). */
export function Card({ title, level = 2, description, actions, children, id: anchor }: BlockProps) {
  const id = useId();
  return (
    <section id={anchor} className="tp-card" aria-labelledby={id}>
      <BlockHeader
        id={id}
        title={title}
        level={level}
        description={description}
        actions={actions}
        prefix="tp-card"
      />
      <div className="tp-card-body">{children}</div>
    </section>
  );
}

/**
 * Columns that collapse by breakpoint: one column below 42rem, two from 42rem, three from 66rem
 * (`columns={3}`). Below the preferred 1280px a three-column grid has two columns, at 400% zoom
 * one (ui-patterns.md, responsive scope).
 */
export function Grid({ columns, children }: { columns: 1 | 2 | 3; children: ReactNode }) {
  return <div className={`tp-grid tp-grid--${columns}`}>{children}</div>;
}
