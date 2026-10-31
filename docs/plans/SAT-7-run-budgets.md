# SAT-7: bounded pipeline execution

Each run snapshots configurable limits: 20 agent execution minutes, 6 agent invocations,
500,000 observed input tokens (cached input is already included), and one
revision cycle by default. Existing configured revision limits are preserved.
The separate timeout applies to each agent invocation, starting when the agent
is dispatched. Settings affect new runs;
workers and server must load the updated build to enforce the new contract.

The server fences every new invocation. The worker aborts its process tree on
the active-time deadline or a usage callback reaching the input threshold.
Server heartbeat and stage completion also check measured usage/time.
Only the `agent` phase (including conflict resolver calls) consumes the time
budget. Slot waiting, worktree creation, dependency setup, worker checks and
integration do not consume it. Worker cancellation and lease monitoring remain
active throughout preparation. Previously accumulated time is preserved.
Agent elapsed time is persisted on heartbeat, stage completion, cancellation,
failure and expired lease. User waiting time is excluded. Expired leases count
up to their expiry to conservatively account for a lost worker.
Resume retains invocation history, usage and active elapsed time. Exhausted
time/token budgets cannot resume. A separately requested restart creates a new
run and budget, retaining the old run for audit.

`blocked` stops execution without a developer revision. Agents are instructed
to use it for unavailable Docker, permissions and other infrastructure issues.
Developer/designer `changes_requested` also stops rather than invoking itself
again. Tester/reviewer functional findings retain the bounded revision path.
Classification of an agent's report still depends on its verdict; arbitrary
free-text infrastructure errors are not reliably machine-classifiable.

Input limits are observational, not a provider billing ceiling: a native CLI
may emit usage only after a request finishes. Overshoot up to that report is
possible. Missing usage remains unknown; time/call limits still apply. Cached
tokens are counted once, and cumulative samples are not added repeatedly.

Worktrees and logs are retained on stopping. Deterministic tests use temporary
repositories and databases and never start paid agents.
