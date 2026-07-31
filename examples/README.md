# Examples

Runnable, end-to-end examples of orangerail on a single concept each. Every example
resolves the `orangerail-*` packages from the workspace, so run them from a checkout
of this repo (see each example's honest caveat about running standalone).

| Example | What it shows |
| --- | --- |
| [unattended-queue](./unattended-queue) | A 15-item back-office queue worked with the operator away. Twelve ordinary writes finish with nobody present; three deletions stop and become approvals bound to the exact call. Start here. |
| [governed-writes](./governed-writes) | The same gate in isolation — one destructive write, blocked, unforceable by the agent, and run only after a human decided, on a hash-chained audit log. |

Each folder has its own `README.md` with the scenario, the exact run steps, and the
proof output.
