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
import {
  DIRECTORY_READ_METHOD,
  SKILLS_EXTENSION,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
  STDIO_MAX_BUFFER_SIZE,
} from './server.js';
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

// ---- SEP-2640 skills/list + skills/get shapes ----

const ResourceDigestSchema = z.object({ uri: z.string(), digest: z.string() });
const SkillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.record(z.unknown()),
  resources: z.array(ResourceDigestSchema).optional(),
});
const SkillsListResultSchema = z.object({
  skills: z.array(SkillEntrySchema),
  nextCursor: z.string().optional(),
});
const SkillsGetResultSchema = z.object({ skill: SkillEntrySchema });
type SkillEntry = z.infer<typeof SkillEntrySchema>;

async function skillsList(client: Client, cursor?: string): Promise<{ skills: SkillEntry[]; nextCursor?: string }> {
  return client.request(
    { method: SKILLS_LIST_METHOD, params: cursor ? { cursor } : {} },
    SkillsListResultSchema,
  );
}

async function runCoreChecks(client: Client): Promise<void> {
  process.stdout.write('\n== Core conformance checks ==\n');

  // Capability advertisement.
  const caps = client.getServerCapabilities();
  const ext = (caps?.extensions as Record<string, unknown> | undefined)?.[SKILLS_EXTENSION] as
    | { directoryRead?: boolean }
    | undefined;
  check('initialize advertises Skills extension capability', !!ext, JSON.stringify(ext ?? caps?.extensions));
  check('extension declares directoryRead: true', ext?.directoryRead === true);

  // resources/list — skills are individually addressable (skill://index.json is retired).
  const list = await client.request({ method: 'resources/list', params: {} });
  const uris = new Set(list.resources.map((r) => r.uri));
  check('resources/list returns resources', list.resources.length > 0, `${list.resources.length} resources`);
  check('resources/list has NO skill://index.json (retired for skills/list)', !uris.has('skill://index.json'));
  check('resources/list includes SKILL.md resources', [...uris].some((u) => u.endsWith('/SKILL.md')));

  // skills/list — the SEP enumeration method (first page).
  const listed = await skillsList(client);
  check('skills/list returns a skills array', Array.isArray(listed.skills), `${listed.skills.length} skills (first page)`);

  // Pick a faithful entry with a complete resources set, preferring one with a supporting file.
  const faithful = listed.skills.filter(
    (s) => s.resources && s.resources.length > 0 && !s.uri.includes('adv-') && !s.uri.includes('refunds'),
  );
  const entry = faithful.find((s) => (s.resources?.length ?? 0) > 1) ?? faithful[0];
  if (!entry || !entry.resources) {
    check('a faithful entry with a resources set exists', false, 'none found in skills/list');
    return;
  }

  // SEP §Resources: the set MUST include an item matching the top-level SKILL.md uri.
  const skillMdDigest = entry.resources.find((r) => r.uri === entry.uri);
  check('entry.resources includes an item for the SKILL.md uri', !!skillMdDigest);

  // Verify the SKILL.md bytes against its per-file digest.
  const skillRead = await readBytes(client, entry.uri);
  const computed = sha256(skillRead.bytes);
  check(
    `SKILL.md digest matches its resources entry (${entry.uri})`,
    !!skillMdDigest && computed === skillMdDigest.digest,
    `entry=${(skillMdDigest?.digest ?? '').slice(0, 23)}… computed=${computed.slice(0, 23)}…`,
  );

  // Verify a SUPPORTING file against its per-file digest — the whole-skill integrity the
  // v1 SEP adds over the old SKILL.md-only digest.
  const supporting = entry.resources.find((r) => r.uri !== entry.uri);
  if (supporting) {
    const sup = await readBytes(client, supporting.uri);
    check(`supporting-file digest matches its resources entry (${supporting.uri})`, sha256(sup.bytes) === supporting.digest);
  } else {
    process.stdout.write('  (picked entry has no supporting file; per-file digest check skipped)\n');
  }

  // resources/read MUST work from the URI alone.
  const direct = await readBytes(client, entry.uri);
  check('SKILL.md readable from its URI alone', direct.bytes.length > 0);

  // skills/get — same entry by URI, listed or not.
  const got = await client.request({ method: SKILLS_GET_METHOD, params: { uri: entry.uri } }, SkillsGetResultSchema);
  check('skills/get returns the same entry by URI', got.skill.uri === entry.uri);
  check(
    'skills/get carries the same resources set as skills/list',
    JSON.stringify(got.skill.resources) === JSON.stringify(entry.resources),
  );

  // skills/get on an unknown URI MUST error with -32602.
  let getErrored = false;
  try {
    await client.request(
      { method: SKILLS_GET_METHOD, params: { uri: 'skill://nonexistent/SKILL.md' } },
      SkillsGetResultSchema,
    );
  } catch (err) {
    getErrored = true;
    const code = (err as { code?: number }).code;
    check('skills/get on unknown URI errors with -32602', code === -32602, `code=${code}`);
  }
  if (!getErrored) check('skills/get on unknown URI errors with -32602', false, 'no error thrown');

  // resources/directory/read on the skill dir.
  const skillDirUri = entry.uri.replace(/\/SKILL\.md$/, '');
  const dir = await client.request(
    { method: DIRECTORY_READ_METHOD, params: { uri: skillDirUri } },
    DirectoryReadResultSchema,
  );
  check(`resources/directory/read lists direct children of ${skillDirUri}`, dir.resources.length > 0, `${dir.resources.length} children`);
  check('directory listing includes SKILL.md as a direct child', dir.resources.some((r) => r.uri === entry.uri));

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

  // SEP Resource Metadata SHOULD + base-MCP `size` on the SKILL.md list item.
  const listFull = await client.request({ method: 'resources/list', params: {} }, ListWithMetaSchema);
  const skillItem = listFull.resources.find((r) => r.uri === entry.uri);
  if (skillItem) {
    const fmName = typeof entry.frontmatter.name === 'string' ? entry.frontmatter.name : undefined;
    check('SKILL.md list entry name == frontmatter.name', !!fmName && skillItem.name === fmName, `name=${skillItem.name}`);
    check('SKILL.md list entry has a description', typeof skillItem.description === 'string');
    check('SKILL.md list entry reports a size', typeof skillItem.size === 'number' && skillItem.size > 0, `size=${skillItem.size}`);
    const metaKey = 'io.modelcontextprotocol.skills/frontmatter';
    const hasMeta = !!skillItem._meta && typeof skillItem._meta[metaKey] === 'object';
    check('SKILL.md list entry exposes frontmatter under _meta prefix', hasMeta);
  } else {
    check('SKILL.md present in resources/list with metadata', false, entry.uri);
  }
}

async function runAdversarialReport(client: Client): Promise<void> {
  process.stdout.write('\n== Adversarial fixtures (documented oracle) ==\n');
  process.stdout.write(
    'No released host consumes skills-over-MCP yet, so these are not executed against a real\n' +
      'host. For each fixture we confirm it is served and print what a SEP-conformant host MUST do.\n' +
      'NOTE: archive fixtures exercise a DEFERRED feature — archives are NOT in the v1 SEP.\n\n',
  );

  // Build the set of served URIs to match fixtures on: skills/list entry URIs + their
  // resources URIs (FIRST PAGE ONLY — do not follow nextCursor; adv-enumeration-exhaustion
  // never ends), plus resources/list URIs (archive blobs, escape children, archive-only refunds).
  const listed = await skillsList(client);
  const resList = await client.request({ method: 'resources/list', params: {} });
  const servedUris = new Set<string>();
  for (const s of listed.skills) {
    servedUris.add(s.uri);
    for (const r of s.resources ?? []) servedUris.add(r.uri);
  }
  for (const r of resList.resources) servedUris.add(r.uri);
  const allUris = [...servedUris];

  if (!allUris.some((u) => u.includes('adv-') || u.includes('refunds'))) {
    process.stdout.write(
      'No adversarial fixtures served. Re-run with --adversarial so the spawned server\n' +
        'serves the adversarial profile (stdio mode does this automatically).\n',
    );
    return;
  }

  // The fixture → SEP → oracle mapping is the SINGLE source in adversarial/catalog.ts.
  process.stdout.write('case | SEP clause | Den item | expected conformant-host action\n');
  process.stdout.write('--------------------------------------------------------------------\n');
  for (const c of ADVERSARIAL_CASES) {
    if (!allUris.some((u) => u.includes(c.key))) continue;
    process.stdout.write(
      `${c.key} | ${c.sepClause} | Den ${c.denItem} | MUST ${c.expectedAction.toUpperCase()}: ${c.oracle}\n`,
    );
  }

  // --- Live demonstrations ---

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
  if (allUris.some((u) => u.includes('adv-walk-budget'))) {
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

  // content-rotation: read the SKILL.md twice; digests differ (TOCTOU).
  const rotationUri = allUris.find((u) => u.includes('adv-content-rotation') && u.endsWith('/SKILL.md'));
  if (rotationUri) {
    const r1 = await readBytes(client, rotationUri);
    const r2 = await readBytes(client, rotationUri);
    const changed = sha256(r1.bytes) !== sha256(r2.bytes);
    check('content-rotation: SKILL.md bytes differ between read #1 and #2 (TOCTOU)', changed);
  }

  // directory-walk-escape: the skill root lists a child that escapes the subtree, and a
  // read of that child MUST miss (it is not a served resource / not in `resources`).
  const escRoot = 'skill://adv-directory-walk-escape';
  if (allUris.some((u) => u.includes('adv-directory-walk-escape'))) {
    try {
      const dir = await client.request(
        { method: DIRECTORY_READ_METHOD, params: { uri: escRoot } },
        DirectoryReadResultSchema,
      );
      const escapeChild = dir.resources.find((r) => r.uri.includes('/../') || !r.uri.startsWith(`${escRoot}/`));
      check('directory-walk-escape: a listed child escapes the skill subtree', !!escapeChild, escapeChild?.uri);
      if (escapeChild) {
        let missed = false;
        try {
          await readBytes(client, escapeChild.uri);
        } catch {
          missed = true;
        }
        check('directory-walk-escape: reading the escaping child misses (host MUST reject)', missed);
      }
    } catch {
      /* fixture not served in this profile */
    }
  }

  // name-collision: >1 entry shares frontmatter.name "review-staged" at distinct URIs
  // (the adv-name-collision fixture plus the faithful corpus skills of that name).
  const collides = listed.skills.filter((s) => s.frontmatter.name === 'review-staged');
  if (collides.length > 1) {
    const distinct = new Set(collides.map((s) => s.uri)).size === collides.length;
    const hasFixture = collides.some((s) => s.uri.includes('adv-name-collision'));
    check(
      'name-collision: >1 entry named "review-staged" (incl. the fixture), each at a distinct URI',
      distinct && hasFixture,
      `${collides.length} entries`,
    );
  }

  // enumeration-exhaustion: follow nextCursor a BOUNDED number of times; it never ends.
  if (allUris.some((u) => u.includes('adv-enumeration-exhaustion'))) {
    const CAP = 5;
    let cursor = listed.nextCursor;
    let pages = 0;
    while (cursor && pages < CAP) {
      const next = await skillsList(client, cursor);
      cursor = next.nextCursor;
      pages++;
    }
    check(
      `enumeration-exhaustion: skills/list still paginating after ${CAP} extra pages (never terminates)`,
      pages === CAP && !!cursor,
      'a host MUST cap how far it follows the cursor',
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
