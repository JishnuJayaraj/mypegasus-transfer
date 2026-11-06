import type { TableSort } from "@transfer/ui";
import { useCallback, useState } from "react";

// The work list's state that is neither a code filter nor the sort (ui-patterns.md, C6): the search
// term, the column choice, the rows shown and the scroll position. Kept in this module's memory
// for the session, per project, so the way back from a participant restores them; never in browser
// storage, the URL or a query key (data-protection.md, the work list; Q223). A reload loses it.

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
};

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
