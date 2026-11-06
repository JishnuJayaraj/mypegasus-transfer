import type { WorklistFilter } from "@transfer/domain";
import type { TableSort } from "@transfer/ui";
import { useCallback, useState } from "react";

// The work list's state that is neither a code filter nor the sort (ui-patterns.md, C6): the search
// term, the column choice, the rows shown and the scroll position. Kept in this module's memory
// for the session, per project, so the way back from a participant restores them; never in browser
// storage, the URL or a query key (data-protection.md, the work list; Q223). A reload loses it.
// The code filters and the sort are the URL's; a copy here, also handed to the participant page in
// the navigation's history state (`worklistReturn`, which a reload of that page keeps, unlike this
// memory), lets its breadcrumb link back to the list as it was left. Only codes, never the term.

/** The columns a sort may name (`sort=deadline`, `sort=-deadline` descending). */
export const sortKeys = [
  "name",
  "status",
  "nextStep",
  "deadline",
  "consultants",
  "wave",
  "agentur",
  "portal",
  "reminded",
  "activation",
  "notice",
  "appointment",
] as const;
export type SortKey = (typeof sortKeys)[number];

/** The sort's code in the URL, or undefined when unknown (a stale link still opens). */
export function parseSortCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.startsWith("-") ? value.slice(1) : value;
  return (sortKeys as readonly string[]).includes(key) ? value : undefined;
}

export function sortFromCode(code: string | undefined): TableSort {
  if (!code) return null;
  return code.startsWith("-")
    ? { key: code.slice(1), direction: "DESC" }
    : { key: code, direction: "ASC" };
}

export function codeFromSort(sort: TableSort): string | undefined {
  if (!sort) return undefined;
  return sort.direction === "DESC" ? `-${sort.key}` : sort.key;
}

export type WorklistMemory = {
  term: string;
  /** Unset until the viewer chooses columns. */
  hiddenColumns?: ReadonlySet<string>;
  /** The rows shown for one filter, search and sort (`key`); another starts afresh. */
  shown?: { key: string; limit: number };
  /** Where the page and the table were scrolled when the list was left, for one `key`. */
  scroll?: { key: string; page: number; table: number };
  /** The code filters and the sort the list was last shown with (the URL's, never the term). */
  search?: WorklistReturn;
};

/** The work list's codes and sort, for the way back from a participant (ui-patterns.md, C6). */
export type WorklistReturn = { filter: WorklistFilter; sort?: string };

/**
 * The history state of a navigation from the work list to a participant: the list's codes and
 * sort as they are when the link is followed.
 */
export function worklistReturn(projectId: string) {
  return () => ({ worklistSearch: worklistMemory(projectId).search });
}

const memory = new Map<string, WorklistMemory>();

/** The project's remembered state (a new one the first time). */
export function worklistMemory(projectId: string): WorklistMemory {
  let entry = memory.get(projectId);
  if (!entry) {
    entry = { term: "" };
    memory.set(projectId, entry);
  }
  return entry;
}

/** Forgets every project's state (tests; a logout reloads the page anyway). */
export function forgetWorklistMemory() {
  memory.clear();
}

/** A piece of state that is also written to the project's memory. */
export function useRemembered<K extends keyof WorklistMemory>(
  projectId: string,
  key: K,
): [WorklistMemory[K], (value: WorklistMemory[K]) => void] {
  const [value, setValue] = useState(() => worklistMemory(projectId)[key]);
  const set = useCallback(
    (next: WorklistMemory[K]) => {
      worklistMemory(projectId)[key] = next;
      setValue(next);
    },
    [projectId, key],
  );
  return [value, set];
}
