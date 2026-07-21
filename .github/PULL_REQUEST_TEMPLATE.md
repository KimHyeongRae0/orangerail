<!--
Before submitting:
- Internal ticket PRs are opened via ./scripts/gh-submit.sh pr <ONT-###>
  (title = the ticket commit title, assignee + labels derived automatically).
- External contributions: title follows Conventional Commits,
  e.g. `feat(core): add defineLink cardinality`.
- New code needs tests that FAIL without this PR and PASS with it.
-->

## Motivation

<!-- What problem does this solve? Reference the issue: -->

Fixes #

## Solution

<!-- Summarize the change. Call out anything reviewers should look at closely. -->

## Checklist

- [ ] Tests added that fail without this PR and pass with it (or explained why not)
- [ ] Docs updated where relevant (README / package docs / `docs/`)
- [ ] `./scripts/verify.sh` passes locally
- [ ] No LLM-inference SDK added to any package (NOLLM-01)
