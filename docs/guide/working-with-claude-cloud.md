# Working with Claude in the cloud — setup and autonomy guide

How to build this product with Claude Code cloud sessions (claude.ai/code, the Claude app's
Code tab, or the desktop app with **Cloud** selected). Cloud sessions keep running after you
close your laptop, and you can check on them from your phone.

---

## Part A — One-time setup (≈ 30 minutes)

### A1. Create the GitHub repository
1. Create a new **private** repo, e.g. `transfer-platform`. Leave it empty.
2. Push this starter (CLAUDE.md, docs/, .claude/, scripts/) as the first commit on `main`.
3. **Protect `main`** (Settings → Branches/Rulesets): require a pull request, require CI to
   pass (once CI exists), block force pushes. This is your most important safety net: Claude
   works on branches, *you* merge.

### A2. Connect GitHub to Claude
- At claude.ai/code, onboarding asks you to install the **Claude GitHub App**. Install it on
  this repository only (not all repos). The app also enables auto-fix for PRs.

### A3. Configure a cloud environment
Open the environment selector (cloud icon above the message box) → add environment
`transfer-platform`:
- **Network access: Trusted** (package registries + GitHub). Don't use Full.
- **Environment variables:** nothing secret. Fine to add e.g. `NODE_ENV=development`.
  Anyone using the environment can read these values.
- **Setup script:** leave empty for now. `scripts/session-start.sh` (run by a SessionStart
  hook in `.claude/settings.json`) starts PostgreSQL and installs dependencies.

### A4. Skills — commit them to the repo
Plugins and your personal `~/.claude/skills` **don't load in cloud sessions**; skills committed
to the repo's `.claude/skills/` do. So install skills *into the repo*:
- In your first cloud session, ask Claude to run
  `npx skills@latest add mattpocock/skills` (choose project scope / Claude Code) and commit the
  result, then run `/setup-matt-pocock-skills`.
- When the setup asks for an issue tracker, choose **local markdown files** (`docs/issues/`).
  GitHub's `gh issue` / `gh pr` commands use GraphQL, which cloud sessions block.
- Pick **one** workflow framework (this guide assumes Matt Pocock's skills). Don't add
  Superpowers on top — their planning/TDD skills overlap and conflict.

### A5. Carbon MCP (optional but useful)
Carbon's MCP server is at `https://mcp.carbondesignsystem.com/mcp` and needs an IBMid login.
Add it on claude.ai as a **custom connector**; connectors work in cloud sessions. If login
doesn't work there, Claude can still read Carbon docs and the `@carbon/react` source in
`node_modules`.

---

## Part B — How each piece of work runs

```
You: pick slice from docs/roadmap.md
 └─► Session 1 (plan): "Plan slice N" → Claude grills you, writes docs/plans/<slice>.md
       └─► YOU review the plan  ◄── most important review of the whole loop
 └─► Session 2 (build): "Implement docs/plans/<slice>.md" → branch, tests, code, PR
       └─► CI runs; auto-fix handles failures
       └─► YOU review the diff + click through the preview
       └─► YOU merge
 └─► Update docs with anything you had to correct
```

Good prompts:
- Planning: *"Read CLAUDE.md and docs/. Plan Slice 2 from the roadmap. Grill me on anything
  unclear before writing the plan. Write it to docs/plans/slice-2.md. Don't write code."*
- Building: *"Implement docs/plans/slice-2.md on a new branch. Tests first for domain logic.
  Run typecheck, lint and tests before pushing. Open a PR when done."*

Rules of thumb:
- One slice per session. Long sessions drift; start fresh with the plan file.
- If Claude gets the domain wrong twice, the doc is missing something — fix the doc.
- Start several sessions in parallel only for **independent** work (e.g. tests for module A
  while building UI for module B), never for the same files.

---

## Part C — When to give the agent more access (autonomy ladder)

You choose the **permission mode** from the mode dropdown when you start a cloud session.
Increase autonomy only when the conditions in the right column are true.

| Level | When | Mode / access | You review |
|---|---|---|---|
| **0 — Think** | Week 1: docs, ADRs, open questions, slice 0 plan | Plan mode. No code. | Everything it writes |
| **1 — Supervised** | Slice 0 (skeleton) and slice 1 (domain core) | Default mode: approve each command and edit. Learn what it runs. Allowlist in `.claude/settings.json` grows from what you approved. | Every step + the PR |
| **2 — Trusted edits** | From slice 2, once CI + tests exist and are green | Accept-edits mode; allowlisted commands run freely; `git push` still asks. | The plan + the PR diff |
| **3 — Autonomous slice** | Well-specified slices, after ~2 slices needed few corrections | Auto mode; Claude works through the plan, pushes its branch, opens the PR, auto-fixes CI. Close your laptop. | The plan + the PR diff + a click-through |

**Move up a level only when all are true:**
1. The slice has a written plan with acceptance criteria that you approved.
2. CI (typecheck, lint, tests) exists and is green on `main`.
3. The relevant domain doc covers the slice.
4. The previous slice needed few corrections.

**Move back down when:** Claude starts touching areas outside the plan, tests get weakened to
pass, the same domain mistake repeats, or a slice involves auth, permissions, deletion of data,
or data protection — those always get level 1–2 and a careful review.

**Never, at any level:**
- Merge to `main` (branch protection enforces this).
- Real participant data, real customer Excel files, or production credentials in a session.
- Production deployments from a coding session — deploys go through CI/CD after your merge.
- Secrets in environment variables of a shared environment.

---

## Part D — Your first three sessions

1. **Session 1 (Plan mode):** *"Read CLAUDE.md and all of docs/. Act as a critical senior
   engineer: list contradictions, gaps and risky assumptions. Add questions to
   docs/open-questions.md. Propose changes to the ADRs. Don't write code."*
   → Fix the docs, answer what you can, ask your PLs for the regional table.
2. **Session 2 (Plan mode):** *"Install mattpocock/skills into this repo and run the setup
   (issues as local markdown in docs/issues/). Then plan Slice 0 into docs/plans/slice-0.md."*
3. **Session 3 (Default mode):** *"Implement docs/plans/slice-0.md."* — approve commands, watch
   what it does, add safe ones to the allowlist. Merge when CI is green.
