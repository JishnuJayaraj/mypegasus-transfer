import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom has no matchMedia; Carbon's UI shell queries it for the breakpoint. (The boundary test
// runs in node, without a window.)
if (typeof window !== "undefined")
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

// jsdom doesn't implement scrolling; TanStack Router's scroll restoration calls it on navigation.
if (typeof window !== "undefined") window.scrollTo = () => {};
