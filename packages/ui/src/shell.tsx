import {
  Content,
  Header,
  HeaderGlobalBar,
  HeaderName,
  SideNav,
  SideNavItems,
  SkipToContent,
} from "@carbon/react";
import type { ReactNode } from "react";

interface AppShellProps {
  productName: string;
  skipToContentLabel: string;
  navLabel: string;
  /** Rendered in the header, left of the global actions (e.g. a hint). */
  headerInfo?: ReactNode;
  /** Header global actions (e.g. the dev user switcher). */
  actions?: ReactNode;
  /** SideNav links. */
  nav: ReactNode;
  children: ReactNode;
}

/** Carbon UI shell: header, fixed side navigation and the main content area. */
export function AppShell(props: AppShellProps) {
  return (
    <>
      <Header aria-label={props.productName}>
        <SkipToContent>{props.skipToContentLabel}</SkipToContent>
        <HeaderName href="/" prefix="">
          {props.productName}
        </HeaderName>
        <HeaderGlobalBar>
          {props.headerInfo && <div className="tp-header-info">{props.headerInfo}</div>}
          {props.actions}
        </HeaderGlobalBar>
      </Header>
      <SideNav aria-label={props.navLabel} expanded isFixedNav isChildOfHeader={false}>
        <SideNavItems>{props.nav}</SideNavItems>
      </SideNav>
      <Content id="main-content" className="tp-content">
        {props.children}
      </Content>
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
