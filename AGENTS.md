<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project maintenance

- Preserve raw sources, correction history, task status, and the separation between user statements and model inferences.
- Never commit data/, backups/, artifacts/, research/, model caches, credentials, private validation reports, or screenshots from actual user sessions. Use labelled synthetic fixtures.
- The owner has authorized a public GitHub repository for this project and committing/pushing completed project changes as part of continued maintenance. Public source never includes personal investment records, account usage, credentials or real-session screenshots. Run relevant checks, inspect the staged diff, and report the commit. Do not force-push, publish a site, or automatically merge external PRs.
- Standard checks: npm test, npm run typecheck, npm run build. Run npm run harness:check when changing the adapter; npm run test:ui when changing interaction flows. The UI runner currently requires macOS Google Chrome.
- npm run memory:setup downloads public model weights. CI must not use a real model API key or execute paid live scripts.
- Reuse the existing checkout. Budget increases and credentials are user decisions; no silent resets of usage records.
- The owner uses this repository as a job-application portfolio. For user-visible iterations, update CHANGELOG.md and relevant README/TESTING sections with the problem, shipped behavior, verification, and limitations. Update docs/PROJECT_CASE_STUDY.md when the product or architecture story changes. Publish versioned GitHub releases for meaningful milestones, keeping package.json/package-lock.json versions aligned. Distinguish implemented, tested, and planned capabilities; never invent metrics or publish private validation outputs.
