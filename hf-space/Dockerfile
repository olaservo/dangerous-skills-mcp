# Hugging Face Docker Space image for the skills-over-mcp adversarial MCP server.
# Built from a staged bundle (see assemble.ps1): server source + vendored corpus.
FROM node:22-alpine

# pnpm via corepack (version pinned by package.json "packageManager").
ENV PNPM_HOME=/pnpm
ENV PATH="/pnpm:$PATH"
RUN corepack enable

WORKDIR /app

# Install deps first (layer cache). tsx is a devDependency, so do a full install.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# App source + vendored corpus (SKILLS_ROOT points here).
COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY CORPUS_LICENSE ./CORPUS_LICENSE

# HF routes external HTTPS to app_port (7860 in README.md). Bind all interfaces,
# point at the vendored corpus, and relax the localhost DNS-rebinding check (the
# Space's public/private setting is the real access control). SERVE_PROFILE
# defaults to "--adversarial" (serve faithful corpus + the SEP-violating
# fixtures); set the Space variable SERVE_PROFILE="" to restrict to faithful.
ENV HOST=0.0.0.0
ENV PORT=7860
ENV SKILLS_ROOT=/app/skills
ENV MCP_DISABLE_DNS_REBINDING_PROTECTION=1
ENV SERVE_PROFILE="--adversarial"

EXPOSE 7860

# Run via tsx (no build step). ${SERVE_PROFILE} expands to "" or "--adversarial".
CMD ["sh", "-c", "pnpm exec tsx src/http.ts ${SERVE_PROFILE}"]
