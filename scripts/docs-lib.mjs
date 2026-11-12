// Shared by the docs checks (scripts/check-docs.mjs, scripts/check-doc-split.mjs): how a Markdown
// file is read as lines, headings, links and sentences. No dependency, no rendering: the docs use
// ATX headings, inline links and fenced code only.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const skippedDirectories = new Set(["node_modules", ".git", "dist", ".tsbuild", "coverage"]);

/** Every `*.md` below `dir`, as paths relative to it, sorted. */
export function markdownFiles(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) found.push(...markdownFiles(dir, path));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }
  return found.toSorted();
}

/** The lines of a document, each with whether it is inside a fenced code block (the fences too). */
export function linesOf(markdown) {
  const lines = [];
  let fence = null;
  for (const text of markdown.split("\n")) {
    const marker = /^\s*(```+|~~~+)/.exec(text)?.[1];
    if (fence === null && marker !== undefined) {
      fence = marker;
      lines.push({ text, code: true });
    } else if (fence !== null) {
      if (marker !== undefined && marker.startsWith(fence) && text.trim() === marker) fence = null;
      lines.push({ text, code: true });
    } else {
      lines.push({ text, code: false });
    }
  }
  return lines;
}

const inlineLink = /!?\[((?:[^\][]|\[[^\][]*\])*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
const inlineCode = /(`+)[^`]*?\1/g;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** `[text](target)` becomes `text`. */
export const withoutLinkTargets = (text) => text.replace(inlineLink, "$1");

/** The headings outside code blocks: level, text as written, and GitHub's anchor. */
export function headingsOf(markdown) {
  const seen = new Map();
  const headings = [];
  for (const { text, code } of linesOf(markdown)) {
    const match = code ? null : heading.exec(text);
    if (match === null) continue;
    const base = slugOf(match[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      level: match[1].length,
      text: match[2],
      slug: count === 0 ? base : `${base}-${count}`,
    });
  }
  return headings;
}

/** GitHub's heading anchor: the visible text, lower case, punctuation dropped, spaces as hyphens. */
export function slugOf(headingText) {
  return withoutLinkTargets(headingText)
    .replace(/[`*]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The inline links outside code: `{ target, line }` (1-based). */
export function linksOf(markdown) {
  const links = [];
  linesOf(markdown).forEach(({ text, code }, index) => {
    if (code) return;
    for (const match of text.replace(inlineCode, "").matchAll(inlineLink)) {
      links.push({ target: match[2], line: index + 1 });
    }
  });
  return links;
}

const listMarker = /^\s*(?:[-*+]|\d+[.)])\s+/;
const onlyLinks = (text) =>
  /\]\(/.test(text) && text.replace(listMarker, "").replace(inlineLink, "").trim() === "";

/**
 * The sentences of a document, for comparing its text before and after a move. Ignored: headings,
 * link targets, lines that hold nothing but links (an index's entries), blank lines, indentation
 * and line wrapping. A table row and a line of a code block each count as one sentence; prose is
 * joined per paragraph or list item and cut after `.`, `!`, `?` or `:` followed by a space.
 */
export function sentencesOf(markdown) {
  const sentences = [];
  let paragraph = [];
  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (text === "") return;
    sentences.push(...text.split(/(?<=[.!?:])\s+/));
  };
  for (const { text, code } of linesOf(markdown)) {
    if (code) {
      flush();
      if (text.trim() !== "") sentences.push(text.trim());
      continue;
    }
    if (text.trim() === "" || heading.test(text) || onlyLinks(text)) {
      flush();
      continue;
    }
    const line = withoutLinkTargets(text).replace(/^\s*>\s?/, "");
    if (/^\s*\|/.test(line)) {
      flush();
      sentences.push(line.replace(/\s+/g, " ").trim());
      continue;
    }
    if (listMarker.test(line)) flush();
    paragraph.push(line);
  }
  flush();
  return sentences;
}

const total = (counts) => [...counts.values()].reduce((sum, n) => sum + n, 0);

function countSentences(texts) {
  const counts = new Map();
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Compares the sentences of the documents before a split with those after it. A sentence must
 * occur after the split exactly as often as before (once, for all but repeated table rules and
 * the like); `missing` lists those found less often, `extra` those found more often or new.
 */
export function compareSentences(before, after) {
  const was = countSentences(before);
  const is = countSentences(after);
  const missing = [];
  const extra = [];
  for (const [sentence, n] of was) {
    const now = is.get(sentence) ?? 0;
    if (now < n) missing.push({ sentence, before: n, after: now });
    if (now > n) extra.push({ sentence, before: n, after: now });
  }
  for (const [sentence, n] of is) {
    if (!was.has(sentence)) extra.push({ sentence, before: 0, after: n });
  }
  return { before: total(was), after: total(is), missing, extra };
}
