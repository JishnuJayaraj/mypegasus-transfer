import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectProblem, testApp } from "./testing";

// Static SPA serving (plan section 5.4, PR 0d): the built web SPA at /, the portal at /portal/.

function fakeDist(name: string) {
  const root = mkdtempSync(join(tmpdir(), `tp-${name}-`));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), `<!doctype html><title>${name}</title>`);
  writeFileSync(join(root, "assets", `${name}-Ab12Cd34.js`), `console.log("${name}")`);
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  return root;
}

const spa = { web: fakeDist("web"), portal: fakeDist("portal") };
const { app } = testApp({ spa });

const IMMUTABLE = "public, max-age=31536000, immutable";

describe("static SPAs", () => {
  it("serves the web index.html at / with no-cache", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>web</title>");
  });

  it("falls back to index.html for client-side routes", async () => {
    for (const path of ["/projects", "/projects/new"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>web</title>");
    }
  });

  it("serves hashed assets as immutable and other files as no-cache", async () => {
    const asset = await app.request("/assets/web-Ab12Cd34.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
    const favicon = await app.request("/favicon.svg");
    expect(favicon.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves the portal at /portal/ with its own fallback and assets", async () => {
    for (const path of ["/portal/", "/portal/some/route"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>portal</title>");
    }
    const asset = await app.request("/portal/assets/portal-Ab12Cd34.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
  });

  it("redirects /portal to /portal/", async () => {
    const res = await app.request("/portal");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/portal/");
  });

  it("answers a missing file with a 404, never index.html", async () => {
    await expectProblem(await app.request("/assets/missing-0000.js"), 404, "not-found");
    await expectProblem(await app.request("/portal/assets/missing.css"), 404, "not-found");
  });

  it("keeps unknown /api paths a 404 problem", async () => {
    for (const path of ["/api", "/api/", "/api/v1/unknown", "/api/v2/projects"]) {
      await expectProblem(await app.request(path), 404, "not-found");
    }
  });

  it("does not serve files outside the dist directories", async () => {
    const res = await app.request("/%2e%2e/%2e%2e/etc/passwd");
    expect(await res.text()).not.toContain("root:");
  });

  it("sends a strict Content-Security-Policy", async () => {
    const csp = (await app.request("/")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("is off when no SPA builds are given (dev: Vite serves them)", async () => {
    const { app: apiOnly } = testApp();
    await expectProblem(await apiOnly.request("/"), 404, "not-found");
  });
});
