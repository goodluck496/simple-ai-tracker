# SAT-7 verification

- Full suite: 99 passed, 0 failed.
- Final focused budget/worker regressions after the last guard/resume change:
  7 passed, 0 failed.
- Server typecheck, full server/web build, final server rebuild: passed.
- git diff --check: passed.
- Tests use temporary Git repositories/in-memory databases and deterministic
  runners. No paid model calls, live task database access or live deployment.
- Regression evidence: exact input-token boundary; cached input counted once;
  retained calls/time after resume; user waiting excluded; exhausted time cannot
  resume; blocked/developer changes_requested stops without revision; live
  usage and active-time deadlines abort the runner and retain its checkout.
- SAT-6 run cancelled through MCP; its separate branch/worktree retained.

Default new-run budgets: 20 active minutes, 6 model invocations, 500,000 input
tokens; default revisions 1. Existing explicitly configured revisions remain
unchanged. Limits are configurable in the automation panel.

Usage limits act on reported cumulative usage and may overshoot until the CLI
reports it. Unknown usage remains unknown; time/call budgets still apply.
Agent infrastructure classification relies on the explicit blocked verdict;
arbitrary prose is not treated as a reliably classified machine error.

Activation requires an updated tracker API/MCP build and a restarted host
worker. The already running Docker container/host worker were not replaced;
no further pipeline jobs were started. Old workers do not gain enforcement
merely because source files changed.
