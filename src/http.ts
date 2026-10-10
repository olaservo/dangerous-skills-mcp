/**
 * http.ts — Run the server over Streamable HTTP.
 *
 *   pnpm serve:http                      # faithful corpus, 127.0.0.1:3940/mcp
 *   pnpm serve:http -- --adversarial     # + adversarial fixtures
 *
 * Served through the SDK's `createMcpHandler` (adapted to `node:http` with
 * `toNodeHandler`): a fresh Server per request, no cross-request session
 * bookkeeping. Modern clients are served at protocol revision 2026-07-28 (the base
 * revision the stable Skills extension spec is written against); 2025-era
 * `initialize` traffic falls back to the SDK's stateless legacy serving.
 *
 * Localhost-only by DEFAULT (security discipline): binds 127.0.0.1 and validates the
 * Host header against localhost names (DNS-rebinding protection). For a remote
 * deploy (e.g. a Hugging Face Docker Space behind HF's HTTPS proxy) set:
 *   HOST=0.0.0.0  PORT=7860               # bind all interfaces on the Space port
 *   ALLOWED_HOSTS=<user>-<space>.hf.space # extra Host header hostname(s), comma-separated
 *   MCP_DISABLE_DNS_REBINDING_PROTECTION=1 # proxy may rewrite Host; relax the check
 * The rebinding check is a localhost-attack mitigation; a remote server's real
 * access control is the Space's public/private setting (private → bearer token).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { buildServer } from './server.js';
import { ResourceRegistry, type RegistryOptions } from './resources.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3940);
const PATHNAME = '/mcp';
// Extra Host header hostnames to accept (comma-separated) — e.g. an HF Space host.
// The check compares hostnames only (any port is accepted).
const EXTRA_ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const ALLOWED_HOSTNAMES = [...new Set([HOST, 'localhost', '127.0.0.1', '::1', ...EXTRA_ALLOWED_HOSTS])];
// DNS-rebinding protection defends a localhost server from browser-driven host
// spoofing. It defaults ON (localhost posture); a remote deploy behind a proxy
// that rewrites the Host header sets MCP_DISABLE_DNS_REBINDING_PROTECTION=1.
const DNS_REBINDING_PROTECTION = process.env.MCP_DISABLE_DNS_REBINDING_PROTECTION !== '1';

function wantsAdversarial(argv: string[]): boolean {
  if (argv.includes('--adversarial')) return true;
  const i = argv.indexOf('--profile');
  return i !== -1 && argv[i + 1] === 'adversarial';
}

function logError(where: string): (err: Error) => void {
  return (err) => process.stderr.write(`[skills-over-mcp] ${where}: ${err.stack ?? err}\n`);
}

async function main(): Promise<void> {
  const adversarial = wantsAdversarial(process.argv.slice(2));
  const opts: RegistryOptions = { adversarial };

  // Build the registry (and pack all archives) ONCE; share it across the per-request
  // servers. This keeps archive bytes/digests stable between the listing and later
  // reads, and avoids re-packing on every request.
  const registry = await ResourceRegistry.build(opts);

  const mcp = createMcpHandler(async () => (await buildServer(opts, registry)).server, {
    legacy: 'stateless',
    onerror: logError('mcp handler error'),
  });
  const handleMcp = toNodeHandler(mcp, { onerror: logError('http adapter error') });
  const hostGuard = DNS_REBINDING_PROTECTION ? hostHeaderValidation(ALLOWED_HOSTNAMES) : undefined;

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
    if (url.pathname !== PATHNAME) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null }));
      return;
    }
    // The guard answers the request itself (403) when the Host header is not allowed.
    if (hostGuard && !hostGuard(req, res)) return;
    void handleMcp(req, res).catch(logError('http handler error'));
  });

  httpServer.listen(PORT, HOST, () => {
    process.stderr.write(
      `[skills-over-mcp] http server ready at http://${HOST}:${PORT}${PATHNAME}` +
        ` (${registry.servedCount()} skills` +
        (adversarial ? `, incl. ${registry.getFixtures().length} adversarial fixtures` : '') +
        ')\n',
    );
  });
}

main().catch((err) => {
  process.stderr.write(`[skills-over-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
