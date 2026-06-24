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

Requires Node 20+ and pnpm. Runs via `tsx` (no build step).

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
