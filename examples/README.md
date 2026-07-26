# Examples

Runnable, end-to-end examples of orangerail on a single concept each. Every example
resolves the `orangerail-*` packages from the workspace, so run them from a checkout
of this repo (see each example's honest caveat about running standalone).

| Example | What it shows |
| --- | --- |
| [governed-writes](./governed-writes) | A destructive write stays available to an agent but is staged for human approval instead of executing — with a hash-chained audit log. Resolves the read-only-vs-write dilemma. |

Each folder has its own `README.md` with the scenario, the exact run steps, and the
proof output.
