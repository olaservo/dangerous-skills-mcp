# dangerous-skills-mcp

A TypeScript MCP server that serves a "dangerous skills" corpus over MCP, implementing the Skills delivery model from [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640). Under an opt-in `--adversarial` profile it also serves a set of crafted, spec-violating fixtures for testing how MCP hosts handle skill delivery — archive path traversal, decompression bombs, digest/frontmatter mismatches, name collisions, and more.

The corpus is forked from [`gricha/dangerous-skills`](https://github.com/gricha/dangerous-skills) (MIT © 2026 Greg Pstrucha). **Every payload is benign** — it writes a marker file or prints a canary string; nothing performs real harm.

## Live endpoint

Deployed as a public Hugging Face Docker Space:

```
https://olaservo-dangerous-skills-mcp.hf.space/mcp
```

It's a free CPU Space, so the first request after idle is a slow cold start — retry once. The live Space runs the `--adversarial` profile. See [`hf-space/README.md`](hf-space/README.md) to run or redeploy it.

Any SEP-2640 host can consume it. With [fast-agent](https://github.com/evalstate/fast-agent):

```text
fast-agent go --shell
/mcp connect --name dsk https://olaservo-dangerous-skills-mcp.hf.space/mcp
/skills registry dsk
/skills add check-licenses
```

## Run locally

Requires Node 22+ and pnpm. Runs via `tsx` (no build step).

```sh
pnpm install

# stdio (the default transport)
pnpm serve:stdio                   # faithful corpus only
pnpm serve:stdio -- --adversarial  # + adversarial fixtures

# HTTP (127.0.0.1:3940/mcp by default)
pnpm serve:http

# smoke client — spawns the server and runs conformance checks
pnpm smoke                   # PASS/FAIL per check
pnpm smoke -- --adversarial  # also prints what a conformant host MUST do per fixture
```

### Reading the oversized fixtures over stdio

Two adversarial fixtures are deliberately larger than the MCP SDK's **default 10 MiB stdio read-buffer cap**: `adv-oversized-payload` (16 MiB) and `adv-walk-budget` (3 × 9 MiB, ~12.6 MiB each once base64-framed). A client using the default cap does not get an error on those reads — the SDK **closes the whole connection**.

This matters for host testing: `adv-oversized-payload`'s oracle is that a host must bound the size of a fetched resource *before* decoding it. A host that simply gets disconnected never receives the payload, and can be mis-scored as having correctly rejected it.

To exercise those fixtures, either use HTTP (`pnpm serve:http`, unaffected by the cap) or raise the cap on your client:

```ts
new StdioClientTransport({ command, args, maxBufferSize: 64 * 1024 * 1024 });
```

This repo's own server and smoke client both set `STDIO_MAX_BUFFER_SIZE` (64 MiB, `src/server.ts`), so `pnpm smoke -- --adversarial` covers them.

## What it serves

Skills are addressed under a `skill://` URI scheme:

- `skill://index.json` — the catalog (per-skill `url` + sha256 `digest`, frontmatter, and archives).
- `skill://<name>/SKILL.md` and supporting files — individually addressable and digest-verifiable.
- `skill://<name>.tar.gz` / `.zip` — per-skill archives.

On top of standard MCP resources it adds a `resources/directory/read` method and advertises the `io.modelcontextprotocol/skills` capability. The `--adversarial` profile adds the spec-violating fixtures (namespaced `adv-`); the smoke client documents each one and the action a conformant host should take. See [`src/adversarial/catalog.ts`](src/adversarial/catalog.ts) for the full list.

## Configuration

- `SERVE_PROFILE` — `--adversarial` to serve fixtures (the HF image's default), empty for the faithful corpus only.
- `SKILLS_ROOT` — corpus root (defaults to the vendored `third_party/dangerous-skills/skills`).
- `HOST` / `PORT` — HTTP bind address (default `127.0.0.1:3940`).
- `ALLOWED_HOSTS`, `MCP_DISABLE_DNS_REBINDING_PROTECTION` — relax the localhost host check for remote hosting behind a proxy.

## License

MIT (see [`LICENSE`](LICENSE)). The vendored corpus is MIT © 2026 Greg Pstrucha ([`gricha/dangerous-skills`](https://github.com/gricha/dangerous-skills)); its notice is kept at [`third_party/dangerous-skills/LICENSE`](third_party/dangerous-skills/LICENSE).
