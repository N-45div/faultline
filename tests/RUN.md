# Test run

Every automated check, run on 2026-09-21 14:39 UTC at commit `a27cc1f`, with the output as it came. Re-run any line from the repo root.

```
$ npm run typecheck
(no output = no type errors)

$ npm run typecheck:tests
(no output = no type errors)

$ npm test   # convex-test, against an in-memory Convex
 Test Files  4 passed (4)
      Tests  43 passed (43)

$ npm run test:engine
149 checks ok
all checks passed

$ npx tsx scripts/receipt-test.ts
111 checks ok
all checks passed

$ npx tsx scripts/state-test.ts
38 checks ok
all checks passed

$ npx tsx scripts/wall-test.ts
10 checks ok
all checks passed

$ npx tsx scripts/md-test.ts
9 checks ok
all checks passed

$ npm run lint:copy
copy lint: clean
```
