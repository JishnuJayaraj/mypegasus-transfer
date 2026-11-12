import { ChevronDown, ChevronRight } from "@carbon/icons-react";
import { useId, useState, type ReactNode } from "react";

interface SectionCardProps {
  title: string;
  /** `h2` on a page, `h3` inside a section or a tab panel. */
  level?: 2 | 3;
  /** One line that stands for the content while the card is collapsed. */
  summary?: ReactNode;
  /** Open at first. Ignored for protected content, which never starts open. */
  defaultOpen?: boolean;
  /**
   * The card holds specially protected content (data-protection.md, classification): it starts
   * collapsed whatever `defaultOpen` says, and its content is not rendered until it is opened.
   */
  protectedContent?: boolean;
  /** Actions for this card only, at the end of its header. */
  actions?: ReactNode;
  /** The card's own id, for an in-page link to it. */
  id?: string;
  children: ReactNode;
}

/**
 * A titled card that collapses to its title and a one-line summary (ui-patterns.md, which
 * pattern). The heading is the button; the content exists only while open. The open state is
 * component state: never stored, so a reload starts from the default again.
 */
export function SectionCard({
  title,
  level = 2,
  summary,
  defaultOpen = false,
  protectedContent = false,
  actions,
  id: anchor,
  children,
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen && !protectedContent);
  const id = useId();
  const Heading = level === 2 ? "h2" : "h3";
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section id={anchor} className="tp-card tp-section-card" aria-labelledby={`${id}-title`}>
      <div className="tp-section-card-header">
        <Heading id={`${id}-title`}>
          <button
            type="button"
            className="tp-section-card-toggle"
            aria-expanded={open}
            aria-controls={`${id}-body`}
            onClick={() => setOpen(!open)}
          >
            <Chevron size={16} aria-hidden="true" />
            {title}
          </button>
        </Heading>
        {!open && summary && <p className="tp-section-card-summary">{summary}</p>}
        {actions && <div className="tp-card-actions">{actions}</div>}
      </div>
      <div id={`${id}-body`} className="tp-section-card-body" hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
