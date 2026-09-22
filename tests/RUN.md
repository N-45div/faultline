# Test run

Every automated check, run on 2026-09-22 05:47 UTC at commit `9332b52`, with the output as it came. Re-run any line from the repo root. The two suites that read live state government files, state-test and md-test, were not run again for this commit: nothing they import has changed since their last run, on 2026-09-21 16:44 UTC at `c54ba1d`, and their counts are from that run.

```
$ npm run typecheck
(no output = no type errors)

$ npm run typecheck:tests
(no output = no type errors)

$ npm test   # convex-test, against an in-memory Convex; the city's API is stood in for, never read
 Test Files  5 passed (5)
      Tests  56 passed (56)

$ npm run test:engine
188 checks ok
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
