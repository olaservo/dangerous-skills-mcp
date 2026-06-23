/**
 * stdio.ts — Run the skills-over-MCP server over stdio (the default, validated
 * transport). Pass `--adversarial` (or `--profile adversarial`) to also serve
 * the SEP-violating fixtures.
 *
 *   pnpm serve:stdio                       # faithful corpus only
 *   pnpm serve:stdio -- --adversarial      # + adversarial fixtures
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

function wantsAdversarial(argv: string[]): boolean {
  if (argv.includes('--adversarial')) return true;
  const i = argv.indexOf('--profile');
  return i !== -1 && argv[i + 1] === 'adversarial';
}

async function main(): Promise<void> {
  const adversarial = wantsAdversarial(process.argv.slice(2));
  const { server, registry } = await buildServer({ adversarial });
  // Log to stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(
    `[skills-over-mcp] stdio server ready: ${registry.servedCount()} skills served` +
      (adversarial ? ` (incl. ${registry.getFixtures().length} adversarial fixtures)` : '') +
      '\n',
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[skills-over-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
