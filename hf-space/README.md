# Deploy the adversarial MCP server as a Hugging Face Docker Space

Follows the `deploy-mcp-server-on-hf` skill (Path B — Docker Space). The server speaks Streamable HTTP on `0.0.0.0:7860`; HF routes external HTTPS to `app_port: 7860` (set in the Space `README.md`). This bundles the server source + a vendored copy of the corpus into a self-contained image.

## Files

- `Dockerfile` — node:22-alpine + pnpm + tsx; runs `src/http.ts` bound to `0.0.0.0:7860`, `SKILLS_ROOT=/app/skills`, DNS-rebinding check off (the proxy rewrites Host). `SERVE_PROFILE` (empty = faithful corpus; `--adversarial` = also serve the SEP-violating fixtures).
- `README.space.md` — the Space's `README.md` (HF metadata + landing page). `assemble.ps1` copies it to the bundle root as `README.md`.
- `.dockerignore`, `assemble.ps1`, and `.staging/` (the assembled bundle, git-ignored).

## 1. Assemble + validate locally (catches the #1 HF failure before pushing)

```powershell
./assemble.ps1
docker build -t skills-over-mcp-space ./.staging
docker run --rm -e SERVE_PROFILE=--adversarial -p 7860:7860 skills-over-mcp-space
# in another shell — MCP initialize with a non-localhost Host header:
curl -s -X POST http://127.0.0.1:7860/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -H 'Host: example.hf.space' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Expect `serverInfo` + the `io.modelcontextprotocol/skills` extension capability in the result.

## 2. Create + push the Space

```bash
# private is the safer default for an adversarial corpus; drop --private to go public
hf repos create olaservo/<space> --type space --space-sdk docker --private
hf upload olaservo/<space> ./.staging . --repo-type space    # or git push the Space remote
hf spaces logs olaservo/<space> --build                       # watch the Docker build
```

To serve the adversarial fixtures on the live Space, set a Space variable (not a secret) `SERVE_PROFILE=--adversarial` in Settings (or `huggingface_hub.add_space_variable`). Leave it unset for faithful-only.

## 3. Verify + point a client

```
https://olaservo-<space>.hf.space/mcp
```
- **Private Space:** clients send `Authorization: Bearer <hf_token>`.
- fast-agent (a SEP-2640 consumer): `/mcp connect --name dsk https://olaservo-<space>.hf.space/mcp`, then `/skills registry dsk`, `/skills add <name>`.

## Notes / decisions

- **Public vs private:** private keeps the (benign but adversarial-by-design) corpus access-controlled; pick deliberately. A public endpoint is open to anyone with the URL.
- **Cold starts:** free CPU Spaces sleep after inactivity; the first request after sleep is slow (clients may need a retry).
- **Stateless:** the server packs archives once at startup and is otherwise stateless, so Space restarts/scale are fine.
- **Attribution:** the corpus MIT license travels as `CORPUS_LICENSE`; coordinate with the author before publishing an MCP-delivered derivative.
