# Test run

Every automated check, run on 2026-09-22 05:47 UTC at commit `29db8e9`, with the output as it came. Re-run any line from the repo root. The two suites that read live state government files, state-test and md-test, were not run again for this commit: nothing they import has changed since their last run, on 2026-09-21 16:44 UTC at `c54ba1d`, and their counts are from that run.

```
$ npm run typecheck
(no output = no type errors)

$ npm run typecheck:tests
(no output = no type errors)

$ npm test   # convex-test, against an in-memory Convex
 Test Files  4 passed (4)
      Tests  63 passed (63)

$ npm run test:engine
171 checks ok
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
```
