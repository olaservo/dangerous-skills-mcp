/**
 * smoke-client.ts — A small MCP client that validates the skills-over-MCP server.
 *
 * Default transport is stdio (spawns `tsx src/stdio.ts`). Use `--http <url>` to
 * hit a running HTTP server. Pass `--adversarial` to also exercise the fixtures
 * (the client prints the SEP-conformant-host oracle for each — there is no real
 * consuming host yet, so the oracle is documented, not executed).
 *
 *   pnpm smoke
 *   pnpm smoke -- --adversarial
 *   pnpm smoke:http              # against a running `pnpm serve:http`
 *
 * Exit code is non-zero if any PASS/FAIL check fails.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { DIRECTORY_READ_METHOD, SKILLS_EXTENSION, STDIO_MAX_BUFFER_SIZE } from './server.js';
import { ADVERSARIAL_CASES } from './adversarial/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Client-side result schema for the custom resources/directory/read method. Kept
 * separate from the server's export on purpose — this is the client's independent
 * check of what came back over the wire. A non-spec method ALWAYS needs an explicit
 * result schema on `client.request()` (only spec methods resolve one by name).
 */
const DirectoryReadResultSchema = z.object({
  resources: z.array(
    z.object({
      uri: z.string(),
      name: z.string(),
      mimeType: z.string(),
      size: z.number().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

/** Permissive resources/list schema that preserves the SEP metadata + base-MCP size fields. */
const ListWithMetaSchema = z.object({
  resources: z.array(
    // zod 4: `z.looseObject` replaces `z.object(...).passthrough()`, and `z.record`
    // takes an explicit key type.
    z.looseObject({
      uri: z.string(),
      name: z.string(),
      mimeType: z.string().optional(),
      description: z.string().optional(),
      size: z.number().optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

function sha256(bytes: Buffer): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  process.stdout.write(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}

interface Args {
  http?: string;
  adversarial: boolean;
}

function parseArgs(argv: string[]): Args {
  const httpIdx = argv.indexOf('--http');
  return {
    http: httpIdx !== -1 ? argv[httpIdx + 1] : undefined,
    adversarial: argv.includes('--adversarial'),
  };
}

async function connect(args: Args): Promise<Client> {
  const client = new Client({ name: 'skills-over-mcp-smoke', version: '1.0.0' });
  if (args.http) {
    const transport = new StreamableHTTPClientTransport(new URL(args.http));
    await client.connect(transport);
    process.stdout.write(`Connected over HTTP: ${args.http}\n`);
  } else {
    const serverEntry = path.resolve(__dirname, 'stdio.ts');
    const spawnArgs = [serverEntry];
    if (args.adversarial) spawnArgs.push('--adversarial');
    const transport = new StdioClientTransport({
      command: process.execPath, // node; tsx loader supplied via NODE_OPTIONS below
      args: spawnArgs,
      env: {
        ...(process.env as Record<string, string>),
        // Load tsx so the child can run the TypeScript entry directly.
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx`.trim(),
      },
      stderr: 'inherit',
      maxBufferSize: STDIO_MAX_BUFFER_SIZE,
    });
    await client.connect(transport);
    process.stdout.write('Connected over stdio (spawned tsx src/stdio.ts)\n');
  }
  return client;
}

async function readBytes(client: Client, uri: string): Promise<{ bytes: Buffer; mimeType?: string; isBlob: boolean }> {
  const res = await client.request({ method: 'resources/read', params: { uri } });
  const content = res.contents[0];
  if (content && 'text' in content && typeof content.text === 'string') {
    return { bytes: Buffer.from(content.text, 'utf8'), mimeType: content.mimeType, isBlob: false };
  }
  if (content && 'blob' in content && typeof content.blob === 'string') {
    return { bytes: Buffer.from(content.blob, 'base64'), mimeType: content.mimeType, isBlob: true };
  }
  throw new Error(`resources/read returned no readable content for ${uri}`);
}

interface IndexDoc {
  skills: Array<{
    url?: string;
    digest?: string;
    frontmatter: Record<string, unknown>;
    archives?: Array<{ url: string; mimeType: string; digest: string }>;
  }>;
}

type IndexEntry = IndexDoc['skills'][number];

/** The URI we match a fixture on: its SKILL.md url, or its first archive url (archive-only). */
function entryMatchUri(e: IndexEntry): string {
  return e.url ?? e.archives?.[0]?.url ?? '';
}

async function runCoreChecks(client: Client): Promise<IndexDoc> {
  process.stdout.write('\n== Core conformance checks ==\n');

  // Capability advertisement.
  const caps = client.getServerCapabilities();
  const ext = (caps?.extensions as Record<string, unknown> | undefined)?.[SKILLS_EXTENSION] as
    | { directoryRead?: boolean }
    | undefined;
  check('initialize advertises Skills extension capability', !!ext, JSON.stringify(ext ?? caps?.extensions));
  check('extension declares directoryRead: true', ext?.directoryRead === true);

  // resources/list
  const list = await client.request({ method: 'resources/list', params: {} });
  const uris = new Set(list.resources.map((r) => r.uri));
  check('resources/list returns the index', uris.has('skill://index.json'), `${list.resources.length} resources`);
  const hasSkillMd = [...uris].some((u) => u.endsWith('/SKILL.md'));
  const hasArchive = [...uris].some((u) => u.endsWith('.tar.gz'));
  check('resources/list includes SKILL.md resources', hasSkillMd);
  check('resources/list includes archive resources', hasArchive);

  // Read index.json
  const indexRead = await readBytes(client, 'skill://index.json');
  const index = JSON.parse(indexRead.bytes.toString('utf8')) as IndexDoc;
  check('skill://index.json parses with a skills array', Array.isArray(index.skills), `${index.skills?.length} skills`);
  process.stdout.write(`  Skill count from index.json: ${index.skills.length}\n`);

  // Pick a faithful, individually-addressable (url+digest) skill for the core checks.
  // Archive-only fixtures (refunds) deliberately omit url/digest, so skip them here.
  const entry = index.skills.find(
    (s) => s.url && s.digest && !s.url.includes('refunds') && !s.url.includes('adv-'),
  );
  if (!entry || !entry.url || !entry.digest) {
    check('a faithful url+digest skill exists for core checks', false, 'none found in index');
    return index;
  }
  const entryUrl = entry.url;
  const entryDigest = entry.digest;

  // Read one SKILL.md and verify digest against index.
  const skillRead = await readBytes(client, entryUrl);
  const computed = sha256(skillRead.bytes);
  check(
    `SKILL.md sha256 matches index digest (${entryUrl})`,
    computed === entryDigest,
    `index=${entryDigest.slice(0, 23)}… computed=${computed.slice(0, 23)}…`,
  );

  // resources/read MUST work from URI alone (independent of index) — re-read it directly.
  const direct = await readBytes(client, entryUrl);
  check('SKILL.md readable from its URI alone (not via index)', direct.bytes.length > 0);

  // resources/directory/read on the skill dir.
  const skillDirUri = entryUrl.replace(/\/SKILL\.md$/, '');
  const dir = await client.request(
    { method: DIRECTORY_READ_METHOD, params: { uri: skillDirUri } },
    DirectoryReadResultSchema,
  );
  const dirHasSkillMd = dir.resources.some((r) => r.uri === entryUrl);
  check(`resources/directory/read lists direct children of ${skillDirUri}`, dir.resources.length > 0, `${dir.resources.length} children`);
  check('directory listing includes SKILL.md as a direct child', dirHasSkillMd);

  // directory/read on a non-directory MUST be an error (-32602).
  let errored = false;
  try {
    await client.request(
      { method: DIRECTORY_READ_METHOD, params: { uri: 'skill://nonexistent/nope' } },
      DirectoryReadResultSchema,
    );
  } catch (err) {
    errored = true;
    const code = (err as { code?: number }).code;
    check('directory/read on unknown URI errors with -32602', code === -32602, `code=${code}`);
  }
  if (!errored) check('directory/read on unknown URI errors with -32602', false, 'no error thrown');

  // Read one archive and verify its digest.
  const archives = entry.archives ?? [];
  const archive = archives.find((a) => a.url.endsWith('.tar.gz')) ?? archives[0];
  if (archive) {
    const archiveRead = await readBytes(client, archive.url);
    check('archive returned as base64 blob', archiveRead.isBlob, archiveRead.mimeType);
    const archiveDigest = sha256(archiveRead.bytes);
    check(
      `archive sha256 matches index digest (${archive.url})`,
      archiveDigest === archive.digest,
      `index=${archive.digest.slice(0, 23)}… computed=${archiveDigest.slice(0, 23)}…`,
    );
  } else {
    check('faithful skill offers an archive', false, `${entryUrl} has no archives`);
  }

  // SEP Resource Metadata SHOULD + base-MCP `size`: the SKILL.md list entry should
  // carry frontmatter-derived name/description, a size, and frontmatter under _meta.
  const listFull = await client.request({ method: 'resources/list', params: {} }, ListWithMetaSchema);
  const skillItem = listFull.resources.find((r) => r.uri === entryUrl);
  if (skillItem) {
    const fmName = typeof entry.frontmatter.name === 'string' ? entry.frontmatter.name : undefined;
    check('SKILL.md list entry name == frontmatter.name', !!fmName && skillItem.name === fmName, `name=${skillItem.name}`);
    check('SKILL.md list entry has a description', typeof skillItem.description === 'string');
    check('SKILL.md list entry reports a size', typeof skillItem.size === 'number' && skillItem.size > 0, `size=${skillItem.size}`);
    const metaKey = 'io.modelcontextprotocol.skills/frontmatter';
    const hasMeta = !!skillItem._meta && typeof skillItem._meta[metaKey] === 'object';
    check('SKILL.md list entry exposes frontmatter under _meta prefix', hasMeta);
  } else {
    check('SKILL.md present in resources/list with metadata', false, entryUrl);
  }
  const archiveItem = listFull.resources.find((r) => r.uri.endsWith('.tar.gz'));
  check('archive list entry reports a size', typeof archiveItem?.size === 'number' && archiveItem.size > 0, `size=${archiveItem?.size}`);

  return index;
}

async function runAdversarialReport(client: Client): Promise<void> {
  process.stdout.write('\n== Adversarial fixtures (documented oracle) ==\n');
  process.stdout.write(
    'No released host consumes skills-over-MCP yet, so these are not executed against a real\n' +
      'host. For each fixture we fetch it and print what a SEP-conformant host MUST do.\n\n',
  );

  const indexRead = await readBytes(client, 'skill://index.json');
  const index = JSON.parse(indexRead.bytes.toString('utf8')) as IndexDoc;
  const advEntries = index.skills.filter((s) => {
    const u = entryMatchUri(s);
    return u.includes('adv-') || u.includes('refunds');
  });

  if (advEntries.length === 0) {
    process.stdout.write(
      'No adversarial fixtures in the index. Re-run with --adversarial so the spawned server\n' +
        'serves the adversarial profile (stdio mode does this automatically).\n',
    );
    return;
  }

  // The fixture → SEP → Den → oracle mapping is the SINGLE source in
  // adversarial/catalog.ts; print it straight from there (no second hand-synced
  // copy to drift). Each case's `key` is the substring we match served URIs on.
  process.stdout.write('case | SEP clause | Den item | expected conformant-host action\n');
  process.stdout.write('--------------------------------------------------------------------\n');
  for (const c of ADVERSARIAL_CASES) {
    const matches = advEntries.filter((e) => entryMatchUri(e).includes(c.key));
    if (matches.length === 0) continue;
    // Fetch one matching fixture to prove it is served. Skip the content-rotation
    // fixture (so its read counter stays clean for the live demo below) and
    // archive-only entries (no individually-addressable url).
    const first = matches[0];
    // Skip heavy/stateful fetches: content-rotation (keep its read counter clean for
    // the live demo below) and oversized-payload (don't pull ~16 MiB just to prove it
    // is served — its size is visible in resources/list).
    if (
      first.url &&
      !first.url.includes('adv-content-rotation') &&
      !first.url.includes('adv-oversized-payload')
    ) {
      try {
        await readBytes(client, first.url);
      } catch {
        /* still print the oracle below */
      }
    }
    process.stdout.write(
      `${c.key} | ${c.sepClause} | Den ${c.denItem} | MUST ${c.expectedAction.toUpperCase()}: ${c.oracle}\n`,
    );
  }

  // Buffer-cap regression guard: SDK v2 caps the stdio read buffer (default 10 MiB) and
  // kills the connection when a single frame exceeds it, so the oversized fixtures only
  // survive because both ends set STDIO_MAX_BUFFER_SIZE. Nothing else in this gate pulls a
  // frame over 10 MiB -- adv-oversized-payload is skipped above and adv-walk-budget's bulk
  // lives in supporting files the loop never touches -- so without this check the cap could
  // be removed and the smoke run would still pass.
  //
  // The threshold is on the DECODED payload (9 MiB), not the frame: that 9 MiB rides the
  // wire as ~12.6 MiB of base64, which is what clears the 10 MiB default cap. Reading it
  // at all proves the raised cap is in effect -- with the default, the read fails and the
  // whole connection closes. Uses part-1.bin rather than the 16 MiB adv-oversized-payload
  // so the gate stays cheap.
  const walkBudgetPart = 'skill://adv-walk-budget/data/part-1.bin';
  if (advEntries.some((e) => entryMatchUri(e).includes('adv-walk-budget'))) {
    let partBytes = 0;
    try {
      partBytes = (await readBytes(client, walkBudgetPart)).bytes.length;
    } catch (err) {
      process.stdout.write(`  read failed: ${(err as Error).message}\n`);
    }
    check(
      'oversized frame survives the stdio buffer cap (adv-walk-budget part-1.bin)',
      partBytes >= 9 * 1024 * 1024,
      `${partBytes} bytes decoded (~${Math.round((partBytes * 4) / 3 / 1024 / 1024)} MiB base64 on the wire)`,
    );
  }

  // Archive-only fidelity (Den A1/A2): the refunds pair MUST omit url/digest and a
  // direct resources/read of their SKILL.md URI MUST miss (not individually addressable).
  const refunds = advEntries.filter((e) => entryMatchUri(e).includes('refunds'));
  if (refunds.length > 0) {
    const allArchiveOnly = refunds.every((e) => !e.url && !e.digest && (e.archives?.length ?? 0) > 0);
    check('archive-only: refunds entries omit url/digest and carry archives', allArchiveOnly);
    // The unpacked SKILL.md would live at skill://<authority>/SKILL.md; it must NOT be
    // individually readable from the server (host must unpack the archive to get it).
    const probe = 'skill://acme/billing/refunds/SKILL.md';
    let missed = false;
    try {
      await readBytes(client, probe);
    } catch {
      missed = true;
    }
    check(`archive-only: direct resources/read of ${probe} misses (host must unpack)`, missed);
  }

  // url-only fidelity: cross-server-read MUST carry url/digest and offer no archive.
  const urlOnly = advEntries.find((e) => (e.url ?? '').includes('adv-cross-server-read'));
  if (urlOnly) {
    check(
      'url-only: cross-server-read carries url/digest and omits archives',
      !!urlOnly.url && !!urlOnly.digest && (urlOnly.archives?.length ?? 0) === 0,
    );
  }

  // Demonstrate content-rotation live: read the SKILL.md twice; digests must differ
  // (read #1 returns the benign body; read #2 returns the rotated/TOCTOU body).
  const rotation = advEntries.find((e) => (e.url ?? '').includes('adv-content-rotation'));
  if (rotation && rotation.url) {
    const r1 = await readBytes(client, rotation.url);
    const r2 = await readBytes(client, rotation.url);
    const changed = sha256(r1.bytes) !== sha256(r2.bytes);
    check('content-rotation: SKILL.md bytes differ between read #1 and read #2 (TOCTOU)', changed);
    process.stdout.write(
      `  content-rotation demonstrated: read#1 vs read#2 bytes ${changed ? 'DIFFER' : 'match'} ` +
        `(a conformant host MUST reject the rotated read).\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`skills-over-mcp smoke client (${args.http ? 'http' : 'stdio'}${args.adversarial ? ', adversarial' : ''})\n`);
  const client = await connect(args);
  try {
    await runCoreChecks(client);
    if (args.adversarial) {
      await runAdversarialReport(client);
    }
  } finally {
    await client.close();
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`smoke client fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
