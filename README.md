# skills-over-mcp-server

A TypeScript MCP server that delivers a vendored "dangerous skills" corpus over MCP for security-research testing, implementing the delivery model from [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) (the Skills extension). It also ships a net-new set of crafted, SEP-violating adversarial fixtures (the research contribution) under a separate profile, so the faithful corpus stays clean.

Part of the [`skills-over-mcp`](https://github.com/olaservo/research-hub/tree/main/mcp/skills-over-mcp) research topic in [research-hub](https://github.com/olaservo/research-hub). The faithful corpus is forked from [`gricha/dangerous-skills`](https://github.com/gricha/dangerous-skills) (MIT © 2026 Greg Pstrucha). Every payload here — corpus and adversarial — is benign: it writes a marker file or prints a canary string; nothing performs real harm. The HTTP transport is localhost-only by default but configurable for remote hosting — it's deployed as a public HF Space (see Status).

## Status — live, and consumable by a real host

The server is deployed as a public HF Docker Space: `https://olaservo-dangerous-skills-mcp.hf.space/mcp` (repo [`olaservo/dangerous-skills-mcp`](https://huggingface.co/spaces/olaservo/dangerous-skills-mcp); in the adversarial profile it serves all 32 skills — 12 faithful + 20 adversarial fixtures). It's a free CPU Space, so the first request after idle is a slow cold start — retry once. To run or redeploy it, see [`hf-space/README.md`](hf-space/README.md). _(Redeploy the Space to pick up new fixtures / the archive-only index shape.)_

A real host consumes this over MCP today: [fast-agent](https://github.com/evalstate/fast-agent) implements the registry/install half of SEP-2640 (`src/fast_agent/skills/mcp_registry.py`). It reads `skill://index.json`, and `/skills add` downloads + SHA-256-verifies + unpacks a skill (with archive-safety hardening — rejects `..`/absolute/symlink/decompression-bomb) into its managed skills dir, where it then runs as a normal local skill. So the over-MCP loop is demonstrable end-to-end — *install from this server → execute* — and the adversarial fixtures can be scored against fast-agent's installer (blocked / installed-with-gap), not just asserted. fast-agent does not yet expose MCP skill resources live to the model, so the install-path MUSTs (archive safety, integrity scope, name-collision) are exercisable while the live model-facing ones (cross-origin reads, live divergence) are not.

Point fast-agent at it:

```text
fast-agent go --shell
/mcp connect --name dsk https://olaservo-dangerous-skills-mcp.hf.space/mcp
/skills registry dsk
/skills add check-licenses        # downloads + verifies + installs over MCP, then run it
```

Two validations remain useful regardless: the smoke client (`src/smoke-client.ts`) exercises the server end-to-end (`resources/list` / `resources/read` / digest-verify / `resources/directory/read` / archive read), and its `--adversarial` mode prints the documented oracle — what a SEP-conformant host MUST do per fixture (reject / gate / re-prompt), tagged with the SEP-2640 clause and reviewer (Den Delimarsky) item.

## Delivery model (SEP-2640)

Skills are addressed under a custom URI scheme **`skill://`**.

- `skill://<skill-path>/<file-path>` — the final `<skill-path>` segment equals `frontmatter.name`. `SKILL.md` is always `skill://<name>/SKILL.md`; supporting files are siblings, e.g. `skill://<name>/scripts/foo.sh`.
- `skill://<name>.tar.gz` and `skill://<name>.zip` — per-skill archives (blob resources).
- `skill://index.json` — the catalog.

The server speaks three things on top of standard MCP resources:

1. `resources/list` — enumerates the index, each `SKILL.md`, each supporting file, and each archive. Per SEP Resource Metadata, each `SKILL.md` entry carries frontmatter-derived `name`/`description` and the full frontmatter under a `io.modelcontextprotocol.skills/frontmatter` `_meta` key (the `io.modelcontextprotocol.skills/` prefix is SEP-reserved; the `frontmatter` key itself is server-defined); static resources also report `size` (the base-MCP `Resource.size`).
2. `resources/read` — text files come back as `contents:[{uri,text,mimeType}]`; binaries and archives come back as base64 `contents:[{uri,blob,mimeType}]`. A skill is readable from its URI alone whether or not it appears in the index (SEP: a skill's URI is *directly readable via `resources/read` whether or not it appears in any index* — which is what lets a host satisfy the MUST to load a skill given only its URI).
3. `resources/directory/read` — a custom JSON-RPC method (registered via a low-level handler with a Zod schema). Given a directory URI (`mimeType: inode/directory`, no trailing slash) it returns that directory's direct children only (non-recursive): `{ resources: [{uri,name,mimeType}, ...] }`, with subdirectories marked `inode/directory`. Unknown / non-directory URIs return JSON-RPC error -32602. A `nextCursor` pagination field is supported in the shape (a no-op today: all direct children fit in one page).

### `skill://index.json`

```json
{
  "skills": [
    {
      "url": "skill://<name>/SKILL.md",
      "digest": "sha256:<hex of raw SKILL.md bytes>",
      "frontmatter": { "name": "...", "description": "...", "...": "all yaml fields" },
      "archives": [
        { "url": "skill://<name>.tar.gz", "mimeType": "application/gzip", "digest": "sha256:<hex of archive bytes>" }
      ]
    }
  ]
}
```

- A skill-entry `digest` is the sha256 of the **raw `SKILL.md` bytes**.
- An archive `digest` is the sha256 of the **archive bytes**.
- `frontmatter` always includes `name` + `description` (plus every other YAML field present).
- Per SEP, every entry MUST include `url`, a non-empty `archives`, or both — and `digest` is present **iff** `url` is. The server serves all three configurations: faithful skills as **both**; the `refunds` name-collision pair as **archive-only** (no `url`/`digest` — its files are not individually addressable, so the host must unpack the archive to address them); and `cross-server-read` as **url-only** (no `archives`).

### Capability declaration

The `initialize` response advertises the Skills extension capability:

```jsonc
"capabilities": {
  "resources": { "listChanged": false },
  "extensions": { "io.modelcontextprotocol/skills": { "directoryRead": true } }
}
```

This uses the installed SDK's `ServerCapabilities.extensions` record (constructor `capabilities` option). `EXPLANATION.md` files in the corpus are **not** served — they are corpus meta.

### Archives

At startup each skill directory is packed into `.tar.gz` (via the `tar` package) and `.zip` (via `archiver`'s `ZipArchive`) into an OS temp cache. `SKILL.md` sits at the archive root; entries are relative. Tar packing is deterministic (portable mode + fixed mtime) so the digest in `index.json` always matches the served bytes.

## Adversarial fixtures (the research contribution)

These live in `src/adversarial/` and are served only when the server runs with `--adversarial` (a.k.a. `--profile adversarial`). They use a separate namespace — names are prefixed `adv-` (the name-collision pair use `refunds` under distinct path prefixes) — so the faithful corpus is never contaminated. Every fixture is benign (marker/canary payloads) and localhost-only.

The fixture → SEP-clause → Den-item → required-host-action mapping lives once in [`src/adversarial/catalog.ts`](src/adversarial/catalog.ts) — the single source the smoke client prints — and, PR-facing, in [findings.md](https://github.com/olaservo/research-hub/blob/main/mcp/skills-over-mcp/findings.md). The table below is a quick index: what each fixture serves, and whether the clause is a current SEP MUST or a Den review proposal not yet in the spec text (a host that *installs* a **Den-proposed** case is evidence the WG should adopt the rule, not a SEP violation). (18 distinct cases; 20 served fixtures, since `name-collision` and `cumulative-budget` are each a pair.)

| Fixture | What it serves | SEP status | Den item |
|---|---|---|---|
| `archive-traversal` | `tar.gz` with `../../evil.txt` and an absolute-path entry | current MUST | C1 |
| `archive-symlink-escape` | symlink `id_rsa.example -> ../../../etc/passwd` (benign decoy) | current MUST | C1 |
| `archive-hardlink-escape` | hard-link `creds.example -> ../../../etc/passwd` (typeflag 1) | current MUST | C1 |
| `decompression-bomb` | tiny `tar.gz` (~130 KB) expanding to ~128 MB | current MUST | C1 |
| `archive-setuid` | `tools/escalate` packed with mode `04755` (setuid bit) | Den-proposed | C1 |
| `archive-non-regular` | `pipe.fifo`, a non-regular (FIFO, typeflag 6) entry | Den-proposed | C1 |
| `cumulative-budget` | two ~30 MiB archives from one server (≈60 MiB aggregate, over a 50 MiB budget) | Den-proposed | C1 |
| `archive-windows-paths` | `tar.gz` with `..\..\evil.txt`, `C:\Windows\evil.txt`, `\\host\share\evil.txt` | current MUST | C1 |
| `archive-normalization-collision` | `tar.gz` shipping `SKILL.md` + a case-fold variant `Skill.md` that overwrites it on a case-insensitive / normalizing FS | Den-proposed | C1 |
| `zip-traversal` | **ZIP** with `../../evil.txt` and an absolute-path entry | current MUST | C1 |
| `zip-symlink-escape` | **ZIP** symlink `id_rsa.example -> ../../../etc/passwd` (S_IFLNK external attrs) | current MUST | C1 |
| `frontmatter-mismatch` | index.json `frontmatter` differs field-by-field from served `SKILL.md` | current MUST¹ | B2 |
| `supporting-file-digest-swap` | **url-only** skill; supporting script fetched undigested (only `SKILL.md` pinned) | Den-proposed | B1 |
| `live-read-divergence` | **both** delivery; archive copy digest-verified, live `resources/read` returns different bytes | Den-proposed | B2 |
| `allowed-tools-grant` | `SKILL.md` frontmatter declares `allowed-tools: [Bash, Write]` | Den-proposed | D5 |
| `content-rotation` | same URI returns different `SKILL.md` bytes/digest on read #2 (TOCTOU) | current MUST + D7 | D7 |
| `name-collision` | two **archive-only** skills both `name: refunds`, under `acme/billing` & `acme/support` (no `url`/`digest`) | Den-proposed (A2) | A2 |
| `cross-server-read` | url-only skill whose `SKILL.md` body induces a cross-origin `resources/read` | Den-proposed | D4 |

¹ The index-vs-`SKILL.md` divergence violates a current MUST (*"the `frontmatter` object MUST be identical in content to the frontmatter of the `SKILL.md` it describes"*); Den B2(1)'s field-by-field host re-verification is the proposed escalation.

## Running it

Requires Node 20+ and pnpm. Run via `tsx` (no build step).

```sh
pnpm install
pnpm typecheck            # tsc --noEmit

# Serve (stdio — the validated default transport)
pnpm serve:stdio                     # faithful corpus only
pnpm serve:stdio -- --adversarial    # + adversarial fixtures

# Serve (HTTP — 127.0.0.1:3940/mcp by default; set HOST/PORT/ALLOWED_HOSTS for remote)
pnpm serve:http
pnpm serve:http -- --adversarial

# Smoke client (spawns the stdio server itself — self-contained)
pnpm smoke                  # core conformance checks, PASS/FAIL per check
pnpm smoke -- --adversarial # also prints the per-fixture documented oracle

# Smoke client over HTTP (point at a running `pnpm serve:http`)
pnpm smoke:http
```

The smoke client prints `PASS`/`FAIL` per check and exits non-zero if any check fails. In `--adversarial` mode it additionally fetches each fixture and prints the SEP clause + Den item + the required host action, and demonstrates the content-rotation TOCTOU live (read #1 vs read #2 bytes differ).

### Configuration

- `SKILLS_ROOT` — override the corpus root (defaults to `../third_party/dangerous-skills/skills`; the HF image sets `/app/skills`).
- `HOST` / `PORT` — HTTP bind address (default `127.0.0.1:3940`; the HF Space uses `0.0.0.0:7860`).
- `ALLOWED_HOSTS` — comma-separated extra `Host` header values to accept (e.g. an HF Space host).
- `MCP_DISABLE_DNS_REBINDING_PROTECTION=1` — relax the localhost host check for a remote deploy behind a proxy (defaults ON / localhost posture; a remote server's real access control is the Space's public/private setting).
- `SERVE_PROFILE` — used by the HF image's `CMD` (`--adversarial` to serve fixtures, empty for faithful only).

## File layout

```
src/
  corpus.ts            # load skills from disk, parse frontmatter, compute skill:// URIs + digests
  index-json.ts        # build the skill://index.json document (+ adversarial frontmatter override)
  archives.ts          # pack .tar.gz / .zip; low-level raw-tar builders for malformed fixtures
  resources.ts         # the resource registry: list / read / directory tree / read counters
  server.ts            # low-level MCP Server: capabilities + resources/list, read, directory/read
  stdio.ts             # stdio entry point
  http.ts              # streamable-HTTP entry point (localhost by default; remote-capable, stateless, shared registry)
  adversarial/
    index.ts           # all adversarial fixture builders, each tagged with SEP clause + Den item
  smoke-client.ts      # MCP client: core checks + documented adversarial oracle
hf-space/              # HF Docker Space deploy bundle (Dockerfile, Space README, assemble.ps1)
```

## Safety discipline

- **Benign only.** Corpus payloads (and every adversarial payload) write marker files or print canary strings. No fixture performs real harm. Do not add real-harm payloads.
- **Localhost-only by default.** The HTTP transport binds `127.0.0.1` + DNS-rebinding protection by default; remote hosting (the HF Space) opts out explicitly via `HOST`/`ALLOWED_HOSTS`/`MCP_DISABLE_DNS_REBINDING_PROTECTION`. A public deploy's real access control is the Space's public/private setting; payloads stay benign either way.
- **Faithful corpus is read-only.** `frontmatter.name` and `SKILL.md` bytes are served verbatim; `EXPLANATION.md` (corpus meta) is excluded. Adversarial cases never touch the faithful set — they are gated behind `--adversarial` and namespaced `adv-` / path-prefixed.

## SDK

Built on the npm-published [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) v1.29.0. Imports used: `@modelcontextprotocol/sdk/server/index.js` (low-level `Server`), `.../server/stdio.js`, `.../server/streamableHttp.js`, `.../types.js` (request schemas, `McpError`, `ErrorCode`), and the client equivalents under `.../client/`.

## Attribution & license

Faithful corpus: MIT © 2026 Greg Pstrucha — [`gricha/dangerous-skills`](https://github.com/gricha/dangerous-skills). This server and the adversarial fixtures are released under MIT as well (see [`LICENSE`](LICENSE)). The corpus keeps its own MIT notice under [`third_party/dangerous-skills/LICENSE`](third_party/dangerous-skills/LICENSE).
