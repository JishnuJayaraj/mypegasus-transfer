import {
  Content,
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderName,
  HeaderPanel,
  SideNav,
  SideNavItems,
  SkipToContent,
  Theme,
} from "@carbon/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** Carbon's `lg` breakpoint: from here the side navigation is a rail beside the content. */
export const WIDE_QUERY = "(min-width: 66rem)";

/** Whether a media query matches, following changes (window resize, zoom). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * The placeholder product mark (D4 of the UX foundation plan): a neutral shape in the text
 * colour, decorative next to the product name. Final branding replaces this and the favicon only.
 */
export function ProductMark() {
  return (
    <svg
      className="tp-product-mark"
      viewBox="0 0 32 32"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6h16l8 10-8 10H4l8-10z" fill="currentColor" />
    </svg>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]';

interface AppShellProps {
  productName: string;
  skipToContentLabel: string;
  navLabel: string;
  /** The menu button's label (opens and closes the navigation). */
  menuLabel: string;
  /** Header global actions (e.g. the user menu). */
  actions?: ReactNode;
  /**
   * SideNav content. Without it (login, logged out) no navigation and no menu button are
   * rendered and the content takes the full width.
   */
  nav?: ReactNode;
  children: ReactNode;
}

/**
 * Carbon UI shell: a dark header (`g100` zone) and, with `nav`, a side navigation that is a rail
 * from 66rem (icons; expands on hover or focus, the menu button keeps it open) and an overlay
 * below (focus stays inside until Escape, the overlay or a link closes it, and returns to the
 * menu button). The open state is component state only, never stored.
 */
export function AppShell(props: AppShellProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  // Opened in which layout: switching between rail and overlay (resize, zoom) starts closed,
  // since a pinned rail isn't an open overlay.
  const [openIn, setOpenIn] = useState<"rail" | "overlay" | null>(null);
  const layout = wide ? "rail" : "overlay";
  const expanded = openIn === layout;
  const menuButton = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navId = useId();
  const hasNav = Boolean(props.nav);
  const overlay = hasNav && !wide && expanded;

  // The overlay takes the focus to its first link.
  useEffect(() => {
    if (!overlay) return;
    navRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [overlay]);

  const close = useCallback((returnFocus: boolean) => {
    setOpenIn(null);
    if (returnFocus) menuButton.current?.focus();
  }, []);

  function onNavKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close(true);
      return;
    }
    if (!overlay || event.key !== "Tab") return;
    // The focus trap: Tab and Shift+Tab cycle through the overlay's links.
    const items = [...(navRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={[
        "tp-shell",
        hasNav ? "tp-shell--nav" : "tp-shell--no-nav",
        hasNav && wide && expanded ? "tp-shell--nav-pinned" : "",
      ].join(" ")}
    >
      <Theme theme="g100">
        <Header aria-label={props.productName}>
          <SkipToContent>{props.skipToContentLabel}</SkipToContent>
          {hasNav && (
            <HeaderMenuButton
              ref={menuButton}
              aria-label={props.menuLabel}
              aria-expanded={expanded}
              aria-controls={navId}
              isActive={expanded}
              isCollapsible
              onClick={() => setOpenIn(expanded ? null : layout)}
            />
          )}
          <HeaderName href="/" prefix="">
            <ProductMark />
            <span className="tp-product-name">{props.productName}</span>
          </HeaderName>
          {props.actions && <HeaderGlobalBar>{props.actions}</HeaderGlobalBar>}
        </Header>
      </Theme>
      {hasNav && (
        <SideNav
          ref={navRef}
          id={navId}
          aria-label={props.navLabel}
          expanded={expanded}
          isRail={wide}
          onOverlayClick={() => close(false)}
          onKeyDown={onNavKeyDown}
          onClick={(event) => {
            // A followed link closes the overlay; the new page gets the focus.
            if (overlay && (event.target as Element).closest("a[href]")) close(false);
          }}
        >
          <SideNavItems>{props.nav}</SideNavItems>
        </SideNav>
      )}
      <Content id="main-content" className="tp-content" inert={overlay || undefined}>
        <div className="tp-content-inner">{props.children}</div>
      </Content>
    </div>
  );
}

/**
 * A group of side navigation links under a label ("Arbeit", "Verwaltung"). In the collapsed rail
 * the label is visually hidden and a divider stands in for it.
 */
export function SideNavGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <li className="tp-nav-group">
      <span className="tp-nav-group-label" id={id}>
        {label}
      </span>
      <ul aria-labelledby={id}>{children}</ul>
    </li>
  );
}

interface HeaderPanelActionProps {
  /** The button's accessible name (and tooltip). */
  label: string;
  icon: ReactNode;
  /** The panel's content; as a function it gets `close` (e.g. after a choice in the panel). */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/**
 * A header action that opens a panel below the header (e.g. the user menu). The panel's content
 * is rendered only while open, so nothing hidden is in the tab order; Escape closes it and
 * returns the focus to the button, as does leaving it with the focus or clicking outside.
 */
export function HeaderPanelAction({ label, icon, children }: HeaderPanelActionProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    const node = panel.current;
    if (!open || !node) return;
    const outside = (target: EventTarget | null) =>
      !(target instanceof Node) || !(node.contains(target) || button.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event.target)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget && outside(event.relatedTarget)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  return (
    <>
      <HeaderGlobalAction
        ref={button}
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        isActive={open}
        tooltipAlignment="end"
        onClick={() => setOpen(!open)}
      >
        {icon}
      </HeaderGlobalAction>
      <HeaderPanel
        ref={panel}
        expanded={open}
        addFocusListeners={false}
        className="tp-header-panel"
      >
        {open && (
          <section id={panelId} aria-label={label}>
            {typeof children === "function" ? children(() => setOpen(false)) : children}
          </section>
        )}
      </HeaderPanel>
    </>
  );
}

interface PortalShellProps {
  productName: string;
  skipToContentLabel: string;
  /** Where the product name links to (the portal's start page). */
  homeHref: string;
  children: ReactNode;
}

/** Participant portal shell (mobile-first): a header and the content, no side navigation. */
export function PortalShell(props: PortalShellProps) {
  return (
    <>
      <Header aria-label={props.productName}>
        <SkipToContent>{props.skipToContentLabel}</SkipToContent>
        <HeaderName href={props.homeHref} prefix="">
          {props.productName}
        </HeaderName>
      </Header>
      <Content id="main-content" className="tp-portal-content">
        {props.children}
      </Content>
    </>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="tp-page-header">
      <h1>{title}</h1>
      {actions}
    </div>
  );
}

/** Sets the document title: the parts, most specific first, then the product name. */
export function useDocumentTitle(productName: string, ...parts: (string | undefined)[]) {
  const title = [parts.filter(Boolean).join(" · "), productName].filter(Boolean).join(" – ");
  useEffect(() => {
    document.title = title;
  }, [title]);
}
