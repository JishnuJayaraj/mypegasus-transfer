import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom has no matchMedia; Carbon's UI shell queries it for the breakpoint.
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
window.scrollTo = () => {};

// Carbon's TabList measures its overflow with a ResizeObserver, which jsdom doesn't have.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Nor element scrolling; Carbon's ComboBox scrolls its highlighted option into view.
Element.prototype.scrollIntoView ??= () => {};
