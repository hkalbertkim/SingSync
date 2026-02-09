# AGENT_RULES (SingSync)

This file defines the operational rules for autonomous development agents (OpenClaw orchestration + Codex coding worker).
The goal is: ship small, safe, measurable improvements continuously without breaking production.

## 0) Non-Negotiables

• Do NOT perform large refactors, renames across the repo, or architectural rewrites.
• Do NOT upgrade frameworks/toolchains (Node major, Next major, React major) unless the ticket explicitly demands it.
• Do NOT change CI/CD, deployment, or environment secrets.
• Do NOT introduce new paid services or external APIs without explicit approval in the ticket.
• Do NOT touch unrelated files “while you are here”. Stay inside the ticket scope.

## 1) Work Selection Policy (Linear)

• Only pick tickets in status: "Now" (or the highest-priority equivalent list/view).
• If "Now" is empty, stop and ask for the next instruction (do not pull from "Next/Later" automatically).
• Never pick “epic/umbrella” tickets. Only pick tickets sized for 2–6 hours of work.

Ticket must contain:
• Problem statement
• Scope (what to change)
• Acceptance Criteria (Definition of Done)
• Test Plan (how to verify)

If any of the above is missing:
• Comment on the ticket requesting the missing info (ONE question only), then move to the next "Now" ticket.

## 2) Branch / Commit / PR Conventions

Branch naming:
• lin-<TICKET_ID>-<short-kebab-title>
– Example: lin-LIN-123-lyrics-candidate-picker

Commit messages:
• (<TICKET_ID>) <imperative summary>
– Example: (LIN-123) Add lyrics candidate selection UI

PR title:
• (<TICKET_ID>) <title>

PR description MUST include:
• Summary (what changed)
• Why (problem being solved)
• How to test (exact commands + manual steps)
• Risks / rollback notes
• Screenshots or short GIF for UI changes (if applicable)

## 3) Safety Limits (Change Budget)

• Max changed files per PR: 12
• Max net new lines per PR: ~400 (if more, split into 2 PRs)
• No cross-cutting refactors
• No dependency upgrades unless necessary to pass tests for the ticket

If the fix requires more than these limits:
• Split the ticket into smaller sub-tickets (comment on Linear) and proceed with the smallest safe slice.

## 4) Repo Boot & Commands (Detect Package Manager)

Determine package manager by lockfile:
• pnpm-lock.yaml → use pnpm
• yarn.lock → use yarn
• package-lock.json → use npm

Standard commands (use the correct package manager):
• Install:
– pnpm install / yarn install / npm ci

• Lint:
– pnpm lint / yarn lint / npm run lint

• Typecheck (if available):
– pnpm typecheck / yarn typecheck / npm run typecheck

• Test:
– pnpm test / yarn test / npm test

• Build (if applicable):
– pnpm build / yarn build / npm run build

If a command is missing in package.json:
• Do NOT invent it.
• Use what exists (inspect package.json scripts).
• Document what you ran in the PR.

## 5) Definition of Done (DoD)

A ticket is Done only if:
• Acceptance Criteria are met.
• Lint passes (or existing lint failures are unchanged and explicitly noted).
• Tests pass (or there are no tests; then provide manual verification steps).
• No new console errors in relevant flows.
• For UI changes: provide screenshot(s).

If tests fail due to pre-existing issues:
• Do NOT “fix the world”.
• Minimize scope: patch only what blocks this ticket.
• Document the failure and the smallest mitigation.

## 6) Observability & Cost Notes (Compute-Fabric Readiness)

When touching anything related to compute jobs, processing pipelines, or “heavy work”:
• Add basic timing/metrics logging where appropriate (without introducing new vendors).
• Ensure logs are structured and searchable.

At minimum, include in PR notes:
• Where the expensive work happens
• Any obvious batching/caching opportunities
• Any potential CHUNK boundaries (future Krako job wrapping)

## 7) Debug / Terminal Rule (No Persistent Pets)

• Do NOT rely on manual SSH/server changes as part of the solution.
• Everything required must be represented in code and reproducible from repo state.
• Any “one-off fix” must be converted into a scripted/reproducible change.

## 8) Failure Handling

If blocked:
• Leave exactly ONE blocking question on the Linear ticket.
• Include:
– What you tried
– The error message
– The file/command involved
• Then move to the next available "Now" ticket.

If CI fails:
• Fix within scope.
• If outside scope: revert the minimal offending change and explain in PR.

## 9) Merge Policy

• Do NOT merge your own PR automatically unless explicitly configured/allowed.
• Leave PR ready for review with clear test steps.
• After PR is merged:
– Update Linear status to Done
– Post a brief closure comment (what shipped, how verified)

## 10) Daily Brief (End-of-Day Summary)

At the end of each cycle/day, post a short Daily Brief to Linear:
• Tickets worked on
• PR links
• What shipped
• What is blocked (one-liners)
• Next suggested ticket (from "Now" only)

End of rules.
