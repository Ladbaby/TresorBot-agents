# TresorBot Agents

Agent adapters for [TresorBot](https://github.com/Ladbaby/TresorBot) Earth.

This repository is a catalogue, not a runtime. Each directory under `adapters/`
is one agent adapter: a manifest and a JavaScript module. Earth installs only the
adapters you choose, from a release bundle, verified against a digest you supply.

The agent host itself lives inside the TresorBot binary. You never clone this
repository to run Earth.

## Installing an adapter

```bash
tresorbot-earth agent install \
  https://github.com/Ladbaby/TresorBot-agents/releases/download/v1.0.0/pi-1.0.0.json \
  --sha256 8f62c4b3b3efff7d41bc7543adee3e035b7bd7063e7a5f15d28346ca2064006c
```

`--sha256` is optional, as with Tresor's `plugin install-url`. Without it the
download is not checked against anything, so install reports the digest it
computed and marks the adapter unverified. Supply the digest to make the install
verifiable.

```bash
tresorbot-earth agent list
tresorbot-earth agent remove pi
```

Adapters land in `~/.tresorbot/agents/<name>/`. Take the digest from
`digests.txt` on the release page, or from a source you trust: HTTPS alone does
not establish that the bytes are the adapter you meant to install.

Installation also fetches the adapter's runtime dependencies. The pi adapter
declares `@earendil-works/pi-coding-agent`, so `npm` must be on `PATH` for it.

## Configuring an adapter

Each adapter reads its own `config.json` beside it, so Earth's config file has no
adapter-specific keys:

```bash
cat > ~/.tresorbot/agents/pi/config.json <<'JSON'
{
  "cli_path": "/path/to/pi-coding-agent/dist/cli.js",
  "tools": ["read", "write", "bash"]
}
JSON
```

Settings are declared in `agent.json` and validated before a session is created.
An undeclared key is rejected rather than ignored, so a typo is reported instead
of silently doing nothing; declared defaults are applied when you omit a key.

Supported types: `string`, `path`, `bool`, `int`, `string_list`, `enum`.

| Adapter | Purpose |
| --- | --- |
| `pi` | Runs the local pi coding agent in the bot's workspace, using its existing settings, model, credentials, extensions, and skills. |
| `echo` | Reference adapter used by the conformance tests. Echoes its input; install it to check that a fresh Earth works. |

## Writing an adapter

An adapter is a directory with two files:

```
adapters/my-agent/
  agent.json     # what it is, and the settings it accepts
  adapter.mjs    # the implementation
```

`agent.json`:

```json
{
  "name": "my-agent",
  "version": "1.0.0",
  "display_name": "My Agent",
  "entry": "adapter.mjs",
  "protocol": 1,
  "requires": ["some-npm-package"],
  "capabilities": ["streaming", "usage"],
  "settings": [
    { "key": "cli_path", "type": "path", "title": "CLI path", "required": true }
  ]
}
```

`adapter.mjs`:

```js
export default function createAdapter() {
  return {
    async createSession(ctx) {
      let resolveSettled;
      const settled = new Promise((r) => (resolveSettled = r));

      return {
        sessionRef: `my-agent:${ctx.conversation_id}`,

        // Resolve when the turn is ACCEPTED, not when it finishes.
        async prompt(text) {
          runTurn(text).then(resolveSettled);
        },

        // Resolve when the turn ends. Must resolve on cancel too.
        wait() {
          return settled;
        },

        async cancel(reason) {
          resolveSettled({ stop_reason: "aborted", text: "" });
        },

        async close() {},
      };
    },
  };
}
```

The rules that matter:

1. **`prompt()` resolves on acceptance.** The host does not block on the agent;
   completion arrives through `wait()`.
2. **`wait()` always resolves**, including after `cancel()`. A promise that never
   settles hangs the assignment.
3. **Report `stop_reason: "stop"` only for a clean finish.** Earth treats every
   other value as incomplete work, which is what keeps the journal honest.
4. **Never forward `ctx.tool_token` to the agent.** It is Earth's credential for
   the loopback tool endpoint; the adapter calls that endpoint on the agent's
   behalf.
5. **Keep `sessionRef` stable per conversation.** It is the only thing that
   survives a restart, and it is what makes resume work.

`adapters/echo/` is a complete, minimal, correct adapter — start there rather
than from the pi adapter, whose bulk is SDK integration.

## Publishing

```bash
node pack.mjs
```

This writes `dist/<name>-<version>.json` for each adapter and `dist/digests.txt`.
Upload the bundles as release assets; operators install by URL plus digest.

A bundle is one JSON object of relative path to file contents. It is verified
before anything is written to disk, so a failed install leaves no half-written
adapter for the host to load. The digest is computed over sorted filenames with
length-prefixed framing and must match TresorBot's
`internal/adapters.SourceDigest` — `internal/adapters/digest_check_test.go` in
TresorBot checks exactly that against the bundles committed here.

## Trust

**Adapters run with the full privileges of Earth's host process.** They can read
and write any file Earth can, open sockets, and spawn processes. There is no
sandbox and no capability restriction.

This is a deliberate trade: an agent adapter's entire job is to run arbitrary
code in a workspace, so pretending to sandbox it would buy nothing but
complexity. The consequence is that installing an adapter is equivalent to
installing software — which is why pinning a digest you obtained from a source
you trust is worth doing.

Only install adapters from sources you trust. HTTPS alone does not establish a
verified publisher signature.
