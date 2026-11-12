// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

// The theme's two rules that a stylesheet or a component could break unnoticed
// (ui-patterns.md, theme and principle 3).

const dir = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => readFileSync(`${dir}${name}`, "utf8");
const sources = readdirSync(dir).filter((name) => /\.(tsx?|scss)$/.test(name));

describe("the theme", () => {
  it("keeps every override of a Carbon class in theme.scss", () => {
    const elsewhere = sources
      .filter((name) => name.endsWith(".scss") && name !== "theme.scss")
      .filter((name) => /\.cds--/.test(read(name)));
    expect(elsewhere).toEqual([]);
    expect(read("theme.scss")).toMatch(/\.cds--/);
  });

  it("names the Carbon version its overrides were checked against: the installed one", () => {
    const checked = /Checked against: @carbon\/react (\S+)/.exec(read("theme.scss"))?.[1];
    expect(checked).toBe(pkg.dependencies["@carbon/react"]);
  });

  it("defines the tokens: surface, the two radii, one elevation, the spacing scale", () => {
    const theme = read("theme.scss");
    expect(theme).toMatch(/--tp-radius-card: 8px;/);
    expect(theme).toMatch(/--tp-radius-control: 6px;/);
    expect(theme.match(/--tp-elevation:/g)).toHaveLength(1);
    expect(theme.match(/--tp-space-\d:/g)).toHaveLength(7);
  });
});

describe("the button rule", () => {
  it("uses no Carbon `secondary` kind anywhere in the kit", () => {
    const using = sources
      .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
      .filter((name) => /kind=\{?"secondary"|secondaryButtonText|"secondary"/.test(read(name)));
    expect(using).toEqual([]);
  });
});
