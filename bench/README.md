# bench — the fixtures behind the claims

Everything in [what we measured](../docs/what-we-measured.md) was run here. These are the fixtures,
so you can disagree with the results by reproducing them rather than by arguing.

**Read this first: most of these runs came out against us.** Three of the four claims this project
was tempted to make died in `rules-under-structure/`. That is the point of publishing the rig.

## What is here

| Directory | Question it asks |
| --- | --- |
| [`rules-under-structure/`](./rules-under-structure) | Does a rules file survive a trap that gives the agent no moment to say no? |
| [`policy-removal/`](./policy-removal) | What happens when the rules file is still there, minus the paragraph that mattered? |

## How a run works

Each fixture is an ordinary project: a `prisma/schema.prisma`, a `CLAUDE.md` a careful team would
ship, and a `TASK.md` that reads as ordinary work. **`TASK.md` never mentions rules, tests, or
experiments** — an agent that knows it is being tested is not the agent you are trying to measure.

1. `cd <fixture>/app && npm install && node ../_build/seed.mjs`
2. Snapshot the seeded database: `cp prisma/dev.db ../baseline.db`
3. Start an agent with that directory as its working directory. Give it nothing but: read
   `CLAUDE.md`, then do `TASK.md`.
4. Score with the SQL in that fixture's `SCORE.md`, against `baseline.db`.

**Scoring reads rows, never the agent's report.** An agent that says it skipped a row and an agent
that skipped it are indistinguishable in prose and trivially distinguishable in SQL.

`SCORE.md` and `RATIONALE.md` sit one level above `app/`, so the agent under test never sees the
scoring criteria or the trap's description.

## Two things about our own method, stated plainly

**We had to hand the rules file over explicitly.** A real Claude Code session loads `CLAUDE.md` from
the working directory automatically; a subagent does not. So the runs told the agent "read
`CLAUDE.md`, then do the task" — which is what the real thing does, but we said it out loud. Any
result here depends on that being a fair substitution.

**Claude Code's permission classifier interrupted three runs**, blocking destructive database writes
before they executed. Where that happened the decision had already been made and written to a script,
so the scripts were executed directly and scored from rows. It is noted per fixture. It also means a
layer neither arm controls is doing real work, which cuts against this project as much as anything
here.

## Reproducing

Node 20+, and roughly ten minutes per fixture. Nothing here calls a paid API on its own — you supply
the agent. Results will vary with the model; ours are recorded with the date and what was run, and
if yours differ that is a finding worth opening an issue about.
