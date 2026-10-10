/**
 * stdio.ts — Run the skills-over-MCP server over stdio (the default, validated
 * transport). Pass `--adversarial` (or `--profile adversarial`) to also serve
 * the SEP-violating fixtures.
 *
 *   pnpm serve:stdio                       # faithful corpus only
 *   pnpm serve:stdio -- --adversarial      # + adversarial fixtures
 *
 * `serveStdio` owns the protocol-era decision for the connection: a modern client
 * (one that sends `_meta["io.modelcontextprotocol/protocolVersion"]`, e.g. the v2
 * SDK client with `versionNegotiation: { mode: 'auto' }`) is served at revision
 * 2026-07-28 — the base revision the stable Skills extension spec is written
 * against — while a 2025-era `initialize` client is still served as before.
 */
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ResourceRegistry } from './resources.js';
import { buildServer, STDIO_MAX_BUFFER_SIZE } from './server.js';

function wantsAdversarial(argv: string[]): boolean {
  if (argv.includes('--adversarial')) return true;
  const i = argv.indexOf('--profile');
  return i !== -1 && argv[i + 1] === 'adversarial';
}

async function main(): Promise<void> {
  const adversarial = wantsAdversarial(process.argv.slice(2));
  // Build the registry once; the factory below hands every Server instance the same one.
  const registry = await ResourceRegistry.build({ adversarial });
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(
    `[skills-over-mcp] stdio server ready: ${registry.servedCount()} skills served` +
      (adversarial ? ` (incl. ${registry.getFixtures().length} adversarial fixtures)` : '') +
      '\n',
  );
  serveStdio(async () => (await buildServer({ adversarial }, registry)).server, {
    // Bring our own transport so the raised read-buffer cap applies (see server.ts).
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: STDIO_MAX_BUFFER_SIZE,
    }),
    onerror: (err) => process.stderr.write(`[skills-over-mcp] stdio error: ${err.stack ?? err}\n`),
  });
}

main().catch((err) => {
  process.stderr.write(`[skills-over-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
