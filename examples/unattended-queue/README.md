# Example: an unattended queue

**The question this answers.** Not "how do I stop my agent" — you can already do that by not
giving it tools. The question is the other one: *how much work can I let it finish while I am
not there, and what is waiting for me when I get back?*

Fifteen back-office items are handed to an agent whose operator has left for the day. Twelve
are ordinary reversible writes — mark orders shipped, restock a product, correct a misspelled
email, add a line item, create a new SKU. Three are deletions: a cancelled order, a customer
who filed an erasure request, a discontinued product.

Nobody is present to answer a prompt. Every one of the twelve finishes anyway. The three
deletions stop, and each becomes an approval bound to the exact call that was refused.

## Run it

From a repo checkout. This folder resolves `orangerail-*` from the monorepo workspace rather
than from npm, so it runs against your working tree.

**Build the workspace first** — the walkthrough spawns the real CLI at
`packages/cli/dist/main.js`, and `dist/` is not committed:

```bash
pnpm install && pnpm -r run build      # from the repo root
```

Then, in this folder:

```bash
npm install                            # prisma + the MCP client
export DATABASE_URL="file:./dev.db"    # prisma reads this; nothing else sets it
npx prisma generate
npx prisma db push
node walkthrough.mjs                   # the whole queue, asserted
```

The run resets the database *and* the approvals store first, so it says the same thing every
time. It asserts every step and exits non-zero on any failure.

## What it prints

```text
──────────────────────────────────────────────────────────────────────────
THE QUEUE — worked start to finish, unattended
──────────────────────────────────────────────────────────────────────────
   1. ✅ DONE      Order o5 has been paid — mark it paid
   2. ✅ DONE      Restock product p2 to 30
   ...
  12. ✅ DONE      New SKU: USB-C dock
  13. ⏸  STAGED    Housekeeping: order o4 was cancelled weeks ago — delete it
         → deleteOrder held as approval 4bd2584f…
  14. ⏸  STAGED    Customer c3 filed an erasure request — delete the record
         → deleteCustomer held as approval 630bcfe2…
  15. ⏸  STAGED    Product p3 is discontinued — delete it
         → deleteProduct held as approval 8d2f0250…

  12 of 12 ordinary items finished with nobody present.
  3 deletions stopped. Every row they name is still there.
```

Then, the next morning:

```text
  orangerail status
    objects:  4
    actions:  4 approval-gated, 8 auto
    baseline: 12 action(s) match orangerail.governance.json
    excluded: 1 model(s) refused — Payment
    pending:  3 approval(s) awaiting a decision
    audit:    chain OK — 27 record(s) verified

  Each of those is an executable call, not a sentence in a report:
    4bd2584f…  deleteOrder({"id":"o4"})
    630bcfe2…  deleteCustomer({"id":"c3"})
    8d2f0250…  deleteProduct({"id":"p3"})
```

The operator approves one — the cancelled order — and leaves the other two. `check_approval`
then runs *that* call, and the row is gone at that moment and not a second earlier. The
erasure request and the discontinued product are still pending, because nobody decided them.

## What this example is, and is not, evidence for

**The client here is a script, not a model.** It walks the queue in order and calls the tools
directly. That is deliberate: the behaviour being demonstrated belongs to the server, and a
scripted client makes the run deterministic and needs no API key. What it establishes is that
the twelve ordinary writes go through with nobody present, that the three deletions cannot,
and that what they leave behind is executable rather than descriptive.

**It does not establish that a model would choose these calls.** That was measured separately,
with a real agent driving a real host against a live Postgres copy of this schema, and the
result is summarised in the root [README](../../README.md#the-run-this-is-built-for) — along
with the arm where the same queue was worked by an agent with full write access and a
well-written markdown rules file, which matched it. Read that section before deciding you need
this.

## Three details worth noticing

**`Payment` has no tool at all.** The surface was generated with `--exclude Payment`, so the
table holding card data is not un-gated — it is absent. `orangerail status` reports it under
`excluded:`, and `orangerail sync` stays green instead of proposing it back on every run. The
walkthrough asserts that no tool matching `payment` exists.

**An approved call runs exactly as staged.** orangerail does not rewrite it, retry it, or
resolve its consequences. Item 15 (`deleteProduct p3`) would fail against the database if
anyone approved it, because order items `i3` and `i6` still reference that product — so the
approval sits there, which is the correct outcome for a request nobody has decided. Fidelity to
the staged call is the property that makes an approval worth anything; it is not a promise that
the call is valid.

**The agent cannot close its own loop.** After staging, the walkthrough has the agent call
`check_approval` itself. It comes back `pending`, and the row is untouched. The decision is not
a step in the agent's workflow.

## The files

| File | What it is |
| --- | --- |
| `prisma/schema.prisma` | four governed tables plus `Payment`, which is deliberately left out |
| `seed.mjs` | resets the database to a fixed starting state |
| `walkthrough.mjs` | the queue, driven through a real MCP client, with assertions |
| `ontology/` | generated by `orangerail init --gate delete --exclude Payment` — yours to edit |
| `orangerail.governance.json` | the recorded posture, including the refusal of `Payment` |

To regenerate the surface yourself:

```bash
node ../../packages/cli/dist/main.js init --yes --preset approval-for-writes \
  --no-studio --exclude Payment
node ../../packages/cli/dist/main.js sync --accept-governance
```

## Related

- [`governed-writes`](../governed-writes) — the same gate shown in isolation, one destructive
  call at a time, with a recorded terminal session.
- [What orangerail does not govern](../../docs/limits.md) — the preconditions this example
  quietly assumes, starting with the agent having no second route to the database.
