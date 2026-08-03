/**
 * http.ts — Run the server over Streamable HTTP.
 *
 *   pnpm serve:http                      # faithful corpus, 127.0.0.1:3940/mcp
 *   pnpm serve:http -- --adversarial     # + adversarial fixtures
 *
 * Stateless mode: a fresh Server + transport is created per POST so there is no
 * cross-request session bookkeeping. enableJsonResponse returns a single JSON
 * body instead of an SSE stream, which the smoke client reads directly.
 *
 * Localhost-only by DEFAULT (security discipline): binds 127.0.0.1 and enables
 * DNS-rebinding protection scoped to localhost. For a remote deploy (e.g. a
 * Hugging Face Docker Space behind HF's HTTPS proxy) set:
 *   HOST=0.0.0.0  PORT=7860               # bind all interfaces on the Space port
 *   ALLOWED_HOSTS=<user>-<space>.hf.space # extra Host header(s), comma-separated
 *   MCP_DISABLE_DNS_REBINDING_PROTECTION=1 # proxy may rewrite Host; relax the check
 * The rebinding check is a localhost-attack mitigation; a remote server's real
 * access control is the Space's public/private setting (private → bearer token).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { buildServer } from './server.js';
import { ResourceRegistry, type RegistryOptions } from './resources.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3940);
const PATHNAME = '/mcp';
// Extra Host header values to accept (comma-separated) — e.g. an HF Space host.
const EXTRA_ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const ALLOWED_HOSTS = [`${HOST}:${PORT}`, `localhost:${PORT}`, HOST, 'localhost', ...EXTRA_ALLOWED_HOSTS];
// DNS-rebinding protection defends a localhost server from browser-driven host
// spoofing. It defaults ON (localhost posture); a remote deploy behind a proxy
// that rewrites the Host header sets MCP_DISABLE_DNS_REBINDING_PROTECTION=1.
const DNS_REBINDING_PROTECTION = process.env.MCP_DISABLE_DNS_REBINDING_PROTECTION !== '1';

function wantsAdversarial(argv: string[]): boolean {
  if (argv.includes('--adversarial')) return true;
  const i = argv.indexOf('--profile');
  return i !== -1 && argv[i + 1] === 'adversarial';
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const adversarial = wantsAdversarial(process.argv.slice(2));
  const opts: RegistryOptions = { adversarial };

  // Build the registry (and pack all archives) ONCE; share it across the stateless
  // per-request servers. This keeps archive bytes/digests stable between the index
  // and later reads, and avoids re-packing on every request.
  const registry = await ResourceRegistry.build(opts);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, opts, registry);
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RegistryOptions,
  registry: ResourceRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  if (url.pathname !== PATHNAME) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null }));
    return;
  }

  try {
    // Fresh server + transport per request (stateless), but reuse the shared registry.
    const { server } = await buildServer(opts, registry);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
      allowedHosts: ALLOWED_HOSTS,
      enableDnsRebindingProtection: DNS_REBINDING_PROTECTION,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const body = await readBody(req);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    process.stderr.write(`[skills-over-mcp] http handler error: ${(err as Error).stack ?? err}\n`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[skills-over-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
