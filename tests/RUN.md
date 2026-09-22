# Test run

Every automated check, run on 2026-09-22 07:50 UTC on the city-page branch (HPD Online's own page for an answered repair, read through Firecrawl), rebased on main with the record sent on, with the output as it came. Re-run any line from the repo root. The two suites that read live state government files, state-test and md-test, were not run again for this commit: nothing they import has changed since their last run, on 2026-09-21 16:44 UTC at `c54ba1d`, and their counts are from that run. The branch was run in a git worktree whose node_modules is a junction to the main checkout's; there, plain `npm test` loads a second copy of convex for the workflow component and fails the seven workflow tests in tenant-loop.test.ts for that reason alone (they fail the same with this branch's changes set aside), so the count below is from `vitest run` with `resolve.preserveSymlinks` set, five runs in a row.

```
$ npm run typecheck
(no output = no type errors)

$ npm run typecheck:tests
(no output = no type errors)

$ npm test   # convex-test, against an in-memory Convex; the city's API and Firecrawl are stood in for, never read
 Test Files  7 passed (7)
      Tests  85 passed (85)

$ npm run test:engine
218 checks ok
all checks passed

$ npx tsx scripts/receipt-test.ts
111 checks ok
all checks passed

$ npx tsx scripts/state-test.ts   # 2026-09-21, c54ba1d
38 checks ok
all checks passed

$ npx tsx scripts/wall-test.ts
10 checks ok
all checks passed

$ npx tsx scripts/md-test.ts   # 2026-09-21, c54ba1d
9 checks ok
all checks passed

$ npm run lint:copy
copy lint: clean

$ npx vite build --outDir <a scratch directory outside the repo>
✓ built
```
