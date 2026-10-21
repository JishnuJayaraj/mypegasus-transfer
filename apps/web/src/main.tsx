import { z } from "zod";

// Zod probes `new Function` when it builds its first object schema unless it runs jitless, and the
// API's CSP (no `unsafe-eval`) reports that probe as a violation (ADR-0004, spike S1). The app is
// loaded only after this setting: a bundle evaluates the shared chunks an entry imports (the
// domain's schemas among them) before the entry's own code, so a first import would run too late.
z.config({ jitless: true });
void import("./app");
