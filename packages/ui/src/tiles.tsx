import { SkeletonPlaceholder } from "@carbon/react";
import { ArrowRight } from "@carbon/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";
import { toneIcon, type StatusTone } from "./status";

interface CountTileProps {
  count: number;
  /** What the count selects, the same text as the list's quick view. */
  label: string;
  /** The severity when the count is not zero; a zero is always neutral. */
  tone: StatusTone;
  /**
   * The link to the counted rows (the app's router link), given the tile's class and content:
   * a tile is always a link, so its accessible name is "count label".
   */
  renderLink: (props: { className: string; children: ReactNode }) => ReactNode;
}

/**
 * A dashboard tile (ui-patterns.md, dashboard): icon, number, label, a severity border and an
 * arrow, as one link. The icon and the text carry the severity, never the colour alone.
 */
export function CountTile({ count, label, tone, renderLink }: CountTileProps) {
  const shown: StatusTone = count === 0 ? "neutral" : tone;
  const Icon = toneIcon[shown];
  return renderLink({
    className: `tp-tile tp-tile--${shown}`,
    children: (
      <>
        <Icon size={20} aria-hidden="true" className="tp-tile-icon" />
        <span className="tp-tile-count">{count}</span>{" "}
        <span className="tp-tile-label">{label}</span>
        <ArrowRight size={16} aria-hidden="true" className="tp-tile-arrow" />
      </>
    ),
  });
}

/** The row of tiles: one column at 400 % zoom, as many as fit beside each other above. */
export function CountTiles({ children }: { children: ReactNode[] }) {
  return (
    <ul className="tp-count-tiles">
      {children.map((tile, index) => (
        <li key={index}>{tile}</li>
      ))}
    </ul>
  );
}

/** Tiles still loading: their places, with a hidden status saying what loads. */
export function TilesSkeleton({ count = 4, label }: { count?: number; label?: string }) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <div aria-busy="true">
      <output className="tp-visually-hidden">{label ?? t("loading")}</output>
      <ul className="tp-count-tiles">
        {Array.from({ length: count }, (_, index) => (
          <li key={index}>
            <SkeletonPlaceholder className="tp-tile-skeleton" />
          </li>
        ))}
      </ul>
    </div>
  );
}
