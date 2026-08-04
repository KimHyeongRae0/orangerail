# Wire it into your agent host

`orangerail mcp` is a **stdio** MCP server. There is no daemon and nothing to toggle: the host
spawns it as a child process, speaks JSON-RPC over its stdin/stdout, and it dies when the host
does. You never start it by hand. (`status`, `approvals` and `audit verify` are ordinary commands
you run in your own terminal, against the same store.)

## The configuration

The `.mcp.json` in the README's Quickstart is the whole configuration:

```json
{
  "mcpServers": {
    "orangerail": {
      "type": "stdio",
      "command": "./node_modules/.bin/orangerail",
      "args": ["mcp"],
      "env": { "DATABASE_URL": "file:./dev.db" }
    }
  }
}
```

The equivalent one-liner writes exactly that file:

```bash
claude mcp add -s project orangerail -e DATABASE_URL="file:./dev.db" \
  -- ./node_modules/.bin/orangerail mcp
```

**`command` names the binary you installed rather than `npx -y orangerail`.** Naming it directly is
the only spelling that can only ever run the copy in this project: an `npx` line resolves to a
fetched copy whenever the local one is missing, and a host running from its own copy makes the
duplicate-install hazard permanent for the one process that does the writing. See
[two copies of `orangerail-core`](./troubleshooting.md#two-copies-of-orangerail-core).

`env` carries whatever your `orangerail.config.mjs` needs to reach your backend. The server
resolves the config from the host's working directory; when that is not your project root, name it
explicitly by appending `"--config", "/abs/path/to/orangerail.config.mjs"` to `args`.

## Confirming the host sees it

```console
$ claude mcp get orangerail
orangerail:
  Scope: Project config (shared via .mcp.json)
  Status: ⏸ Pending approval (run `claude` to approve)
  Type: stdio
  Command: ./node_modules/.bin/orangerail
  Args: mcp
  Environment:
    DATABASE_URL=file:./dev.db
```

`⏸ Pending approval` is the host asking, not the config being wrong: a project-scoped `.mcp.json`
is only connected to once you have trusted the directory, and the same readout says `✔ Connected`
afterwards.

As the server comes up it writes one line to stderr (stdout is the JSON-RPC channel), which lands
in your host's log:

```console
orangerail mcp: serving · governance active · 2 action(s) approval-gated · matches the recorded baseline · audit chain OK (0 record(s))
```

## Running from source instead

To run an unreleased change, clone this repository, `pnpm install && pnpm -r run build` (`dist/` is
not committed), and swap the server object's `command` and `args` for `"node"` and
`["/abs/path/to/orangerail/packages/cli/dist/main.js", "mcp"]`.

## Also asking the host to prompt

If your host has a permission prompt of its own, orangerail can ask it to fire on the writes you
left un-gated — off by default, and with real caveats:
[Also ask the host to prompt](./host-approval-prompt.md).
