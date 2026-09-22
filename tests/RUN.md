# Test run

Every automated check, run on 2026-09-22 11:34 UTC at `d6cefad` on main, with the output as it came. Re-run any line from the repo root. Every suite was run again for this commit, including the two that read live state government files, state-test and md-test. The run was in the main checkout, with its own node_modules, so the count below is from plain `npm test`. On Windows, after md-test printed `all checks passed`, Node printed a libuv assertion, `!(handle->flags & UV_HANDLE_CLOSING)`, while it was exiting; its nine checks had passed before that. The checks come to 481: 95 tests, and 218, 111, 38, 10 and 9 from the scripts. The build at the end was run on the same commit at 11:38 UTC.

```
$ npm run typecheck
(no output = no type errors)

$ npm run typecheck:tests
(no output = no type errors)

$ npm test   # convex-test, against an in-memory Convex; the city's API, Firecrawl and AgentMail are stood in for, never reached
 Test Files  8 passed (8)
      Tests  95 passed (95)

$ npm run test:engine
218 checks ok
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
(then, as Node exited, the libuv assertion !(handle->flags & UV_HANDLE_CLOSING))

$ npm run lint:copy
copy lint: clean

$ npx vite build --outDir <a scratch directory outside the repo>   # 11:38 UTC, d6cefad
✓ built
```
