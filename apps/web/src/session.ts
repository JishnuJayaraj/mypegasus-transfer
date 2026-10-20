import type { ApiClient } from "@transfer/api-client";

/**
 * The browser's view of the staff session (Slice 3 plan, Web): whether this page had one, so a
 * 401 after it is "Sitzung abgelaufen" while a first visit just asks to log in.
 */
export interface SessionTracker {
  /** A logout: the next 401 is no expiry. */
  end(): void;
}

/**
 * Watches every API response: a 401 anywhere calls `onUnauthenticated` with whether a session
 * had been active. Registered after the client's problem middleware, so it runs before it.
 */
export function watchSession(
  api: ApiClient,
  onUnauthenticated: (expired: boolean) => void,
): SessionTracker {
  // True once `/me` answered; false again after a 401 or a logout.
  let active = false;
  api.use({
    onResponse({ request, response }) {
      if (response.status === 401) {
        const expired = active;
        active = false;
        onUnauthenticated(expired);
      } else if (response.ok && new URL(request.url).pathname === "/api/v1/me") {
        active = true;
      }
      return undefined;
    },
  });
  return {
    end() {
      active = false;
    },
  };
}
