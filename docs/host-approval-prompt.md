# Also ask the host to prompt (optional, off by default)

An action you declared **without** `policy: { approval: 'required' }` has no orangerail gate:
calling its tool runs it. If your host has a permission prompt of its own, orangerail can ask
it to fire on every call to exactly those tools, by setting one field in
`orangerail.config.mjs`:

```js
export default {
  registry,
  store,
  // 'off' (default) | 'ungoverned-actions' | 'all-actions'
  hostApprovalPrompt: 'ungoverned-actions',
};
```

That adds `_meta: { "anthropic/requiresUserInteraction": true }` to those tools' entries in
`tools/list`. **Claude Code v2.1.199 and later is the only host known to honor it.** The key is
vendor-prefixed, which the MCP specification reserves for exactly this, so any other host reads
it as metadata it does not recognize and ignores it — there is no behavior change anywhere else
and nothing to disable.

`'all-actions'` extends it to your governed actions too. That is a second prompt in front of a
call that only *stages* an approval, so the write still cannot happen either way; what it buys
is that an agent cannot silently fill your approval queue. Most people should not want it. Read
tools and `check_approval` are never annotated under any setting: `check_approval` is polled in
a loop until a human decides, and a prompt on every poll is unusable.

Be deliberate about turning this on, because the flagged tool's prompt is not one the person at
the keyboard can dismiss. Per Claude Code's documentation it appears in every permission mode
including `bypassPermissions`, offers no "don't ask again", and is not skipped by an allow rule;
in `dontAsk` mode, which never prompts, the call is **denied** instead. A headless pipeline that
was working can stop working. That is why the default is `'off'`, and why for a one-off you may
prefer an ordinary `ask` rule in your host's own settings — that one you can take back.

And to be exact about what this is: the annotation is enforced by the **client**. It is not what
makes orangerail's gate hold. A governed action stages and waits for a human no matter which
host is driving, whether that host prompts, and whether it honors this key at all. The host
prompt is a second checkpoint on top of the rail — never the rail.

Note the tension with running unattended. This feature exists for the case where a person *is*
at the keyboard and wants a prompt on the un-gated writes. If your goal is to leave the agent
working while you are away, `'off'` is the setting that serves it, and the approval gate — which
does not need anybody present to hold — is the mechanism that does.
