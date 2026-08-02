# Examples

Runnable, end-to-end examples of orangerail on a single concept each. Every example
resolves the `orangerail-*` packages from the workspace, so run them from a checkout
of this repo (see each example's honest caveat about running standalone).

| Example | What it shows |
| --- | --- |
| [unattended-queue](./unattended-queue) | A 15-item back-office queue worked with the operator away. Twelve ordinary writes finish with nobody present; three deletions stop and become approvals bound to the exact call. Start here. |
| [governed-writes](./governed-writes) | The same gate in isolation — one destructive write, blocked, unforceable by the agent, and run only after a human decided, on a hash-chained audit log. |
| [vs-a-rules-file](./vs-a-rules-file) | orangerail run against the things you would do instead: a rules file — project *and* global, as a real host reads them — and a precondition written by hand. Three scenarios, both arms executed, every verdict scored from the rows. The baseline wins where the two scopes overlap, and stops holding under an account whose home is not yours, when the line is removed, or when the row stops carrying the field the check reads. |

Each folder has its own `README.md` with the scenario, the exact run steps, and the
proof output.
