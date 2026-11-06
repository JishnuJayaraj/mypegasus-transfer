import { useBlocker } from "@tanstack/react-router";
import type { PendingNavigation } from "@transfer/ui";

/**
 * Holds back a navigation (e.g. the browser's back button) while a side panel has unsaved input,
 * so the panel can ask "Änderungen verwerfen?" (ui-patterns.md, C4). The reload is the panel's
 * own `beforeunload`.
 */
export function usePanelNavigationGuard(dirty: boolean): PendingNavigation | undefined {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: false,
  });
  return blocker.status === "blocked"
    ? { proceed: blocker.proceed, reset: blocker.reset }
    : undefined;
}
