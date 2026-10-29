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
 *   pnpm smoke -- --legacy       # connect as a 2025-11-25 client
 *   pnpm smoke:http              # against a running `pnpm serve:http`
 *
 * Exit code is non-zero if any PASS/FAIL check fails.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  GetSkillResultSchema,
  ListSkillsResultSchema,
  ReadResourceDirectoryResultSchema,
  RESOURCES_DIRECTORY_READ_METHOD,
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
} from '@modelcontextprotocol/core/ext/skills';
import { z } from 'zod';
import { STDIO_MAX_BUFFER_SIZE } from './server.js';
import { ADVERSARIAL_CASES } from './adversarial/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Result schemas for the three extension methods. A non-spec method ALWAYS needs an
 * explicit result schema on `client.request()` (only spec methods resolve one by name).
 *
 * The faithful profile is validated with the SDK's own schemas from
 * `@modelcontextprotocol/core/ext/skills`: a well-formed `sha256:` digest on every
 * resource, string `name`/`description` in every frontmatter, `ttlMs`/`cacheScope`
 * required. The adversarial profile deliberately serves entries that break those rules
 * (a `file:` URI, tampered frontmatter), so it is read with the permissive local copies
 * below and the per-fixture checks say what a host must do with each entry.
 *
 * NOTE: the v2 client consumes the 2026-07-28 `resultType` discriminator while
 * decoding, so it never reaches these schemas; the raw-wire conformance probe is what
 * asserts `resultType: "complete"`. `ttlMs` / `cacheScope` do pass through.
 */
const LooseDirectoryReadResultSchema = z.object({
  resources: z.array(
    z.looseObject({
      uri: z.string(),
      name: z.string(),
      mimeType: z.string(),
      size: z.number().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
  ttlMs: z.number().int().nonnegative().optional(),
  cacheScope: z.enum(['public', 'private']).optional(),
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
  /** Connect with the plain 2025-11-25 handshake instead of negotiating 2026-07-28. */
  legacy: boolean;
}

function parseArgs(argv: string[]): Args {
  const httpIdx = argv.indexOf('--http');
  return {
    http: httpIdx !== -1 ? argv[httpIdx + 1] : undefined,
    adversarial: argv.includes('--adversarial'),
    legacy: argv.includes('--legacy'),
  };
}

async function connect(args: Args): Promise<Client> {
  // 'auto' probes with server/discover and lands on protocol revision 2026-07-28 when
  // the server speaks it (the base revision of the stable Skills extension spec);
  // 'legacy' is the plain 2025 connect sequence of a client without the option.
  const client = new Client(
    { name: 'skills-over-mcp-smoke', version: '1.0.0' },
    { versionNegotiation: { mode: args.legacy ? 'legacy' : 'auto' } },
  );
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

// ---- SEP-2640 skills/list + skills/get shapes (permissive copies for the adversarial profile) ----

// Spec SkillResource: every item carries the digest AND byte size of the raw content.
const LooseSkillResourceSchema = z.object({ uri: z.string(), digest: z.string(), size: z.number().int().nonnegative() });
const LooseSkillEntrySchema = z.object({
  uri: z.string(),
  // zod 4: `z.record` takes an explicit key type.
  frontmatter: z.record(z.string(), z.unknown()),
  // REQUIRED: the complete array, or the string "dynamic" for a generated skill.
  resources: z.union([z.array(LooseSkillResourceSchema), z.literal('dynamic')]),
});
// ListSkillsResult / GetSkillResult extend CacheableResult: ttlMs + cacheScope are REQUIRED.
const CacheableFields = { ttlMs: z.number().int().nonnegative(), cacheScope: z.enum(['public', 'private']) };
const LooseSkillsListResultSchema = z.object({
  skills: z.array(LooseSkillEntrySchema),
  nextCursor: z.string().optional(),
  ...CacheableFields,
});
const LooseSkillsGetResultSchema = z.object({ skill: LooseSkillEntrySchema, ...CacheableFields });
type SkillEntry = z.infer<typeof LooseSkillEntrySchema>;
type SkillResource = z.infer<typeof LooseSkillResourceSchema>;

/** The result schemas in use: the SDK's for the faithful profile, the permissive copies for --adversarial. */
const STRICT_WIRE = { list: ListSkillsResultSchema, get: GetSkillResultSchema, dir: ReadResourceDirectoryResultSchema };
const LOOSE_WIRE = { list: LooseSkillsListResultSchema, get: LooseSkillsGetResultSchema, dir: LooseDirectoryReadResultSchema };
let wire: typeof STRICT_WIRE | typeof LOOSE_WIRE = STRICT_WIRE;

async function skillsList(
  client: Client,
  cursor?: string,
): Promise<{ skills: SkillEntry[]; nextCursor?: string; ttlMs: number; cacheScope: string }> {
  return client.request({ method: SKILLS_LIST_METHOD, params: cursor ? { cursor } : {} }, wire.list);
}

async function skillsGet(client: Client, uri: string): Promise<{ skill: SkillEntry; ttlMs: number; cacheScope: string }> {
  return client.request({ method: SKILLS_GET_METHOD, params: { uri } }, wire.get);
}

async function directoryRead(
  client: Client,
  uri: string,
  cursor?: string,
): Promise<{ resources: Array<{ uri: string; name: string; mimeType?: string; size?: number }>; nextCursor?: string; ttlMs?: number; cacheScope?: string }> {
  return client.request({ method: RESOURCES_DIRECTORY_READ_METHOD, params: cursor ? { uri, cursor } : { uri } }, wire.dir);
}

async function runCoreChecks(client: Client, args: Args): Promise<void> {
  const { adversarial } = args;
  process.stdout.write('\n== Core conformance checks ==\n');

  // Protocol revision: the stable Skills extension spec is written against 2026-07-28;
  // with --legacy the client runs the plain 2025 handshake and must still be served.
  const expected = args.legacy ? '2025-11-25' : '2026-07-28';
  const negotiated = client.getNegotiatedProtocolVersion();
  check(`negotiated protocol revision is ${expected}`, negotiated === expected, `protocolVersion=${negotiated}`);

  // Capability advertisement.
  const caps = client.getServerCapabilities();
  const ext = (caps?.extensions as Record<string, unknown> | undefined)?.[SKILLS_EXTENSION_ID] as
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
  check(
    'skills/list carries ttlMs + cacheScope (CacheableResult, 2026-07-28)',
    Number.isInteger(listed.ttlMs) && (listed.cacheScope === 'public' || listed.cacheScope === 'private'),
    `ttlMs=${listed.ttlMs} cacheScope=${listed.cacheScope}`,
  );
  // Every entry carries `resources` (array or "dynamic"); every array item carries an integer size.
  check(
    'every listed entry has resources: array | "dynamic", each item with integer size',
    listed.skills.every(
      (s) => s.resources === 'dynamic' || s.resources.every((r) => Number.isInteger(r.size) && r.size >= 0),
    ),
  );

  // Pick a faithful entry with a complete resources set, preferring one with a supporting file.
  const faithful = listed.skills.filter(
    (s) => Array.isArray(s.resources) && s.resources.length > 0 && !s.uri.includes('adv-') && !s.uri.includes('refunds'),
  );
  const entry = faithful.find((s) => Array.isArray(s.resources) && s.resources.length > 1) ?? faithful[0];
  if (!entry || !Array.isArray(entry.resources)) {
    check('a faithful entry with a resources set exists', false, 'none found in skills/list');
    return;
  }
  const entryResources: SkillResource[] = entry.resources;

  // SEP §Resources: the set MUST include an item matching the top-level SKILL.md uri.
  const skillMdDigest = entryResources.find((r) => r.uri === entry.uri);
  check('entry.resources includes an item for the SKILL.md uri', !!skillMdDigest);

  // Verify the SKILL.md bytes against its per-file digest AND size.
  const skillRead = await readBytes(client, entry.uri);
  const computed = sha256(skillRead.bytes);
  check(
    `SKILL.md digest matches its resources entry (${entry.uri})`,
    !!skillMdDigest && computed === skillMdDigest.digest,
    `entry=${(skillMdDigest?.digest ?? '').slice(0, 23)}… computed=${computed.slice(0, 23)}…`,
  );
  check(
    'SKILL.md byte length matches its resources entry size',
    !!skillMdDigest && skillRead.bytes.length === skillMdDigest.size,
    `entry=${skillMdDigest?.size} read=${skillRead.bytes.length}`,
  );

  // Verify a SUPPORTING file against its per-file digest + size — the whole-skill
  // integrity the v1 SEP adds over the old SKILL.md-only digest.
  const supporting = entryResources.find((r) => r.uri !== entry.uri);
  if (supporting) {
    const sup = await readBytes(client, supporting.uri);
    check(`supporting-file digest matches its resources entry (${supporting.uri})`, sha256(sup.bytes) === supporting.digest);
    check(`supporting-file byte length matches its resources entry size`, sup.bytes.length === supporting.size, `entry=${supporting.size} read=${sup.bytes.length}`);
  } else {
    process.stdout.write('  (picked entry has no supporting file; per-file digest check skipped)\n');
  }

  // resources/read MUST work from the URI alone.
  const direct = await readBytes(client, entry.uri);
  check('SKILL.md readable from its URI alone', direct.bytes.length > 0);

  // skills/get — same entry by URI, listed or not.
  const got = await skillsGet(client, entry.uri);
  check('skills/get returns the same entry by URI', got.skill.uri === entry.uri);
  check(
    'skills/get carries the same resources set as skills/list',
    JSON.stringify(got.skill.resources) === JSON.stringify(entryResources),
  );
  check(
    'skills/get carries ttlMs + cacheScope (CacheableResult, 2026-07-28)',
    Number.isInteger(got.ttlMs) && (got.cacheScope === 'public' || got.cacheScope === 'private'),
    `ttlMs=${got.ttlMs} cacheScope=${got.cacheScope}`,
  );

  // skills/get on an unknown URI MUST error with -32602.
  let getErrored = false;
  try {
    await skillsGet(client, 'skill://nonexistent/SKILL.md');
  } catch (err) {
    getErrored = true;
    const code = (err as { code?: number }).code;
    check('skills/get on unknown URI errors with -32602', code === -32602, `code=${code}`);
  }
  if (!getErrored) check('skills/get on unknown URI errors with -32602', false, 'no error thrown');

  // resources/directory/read on the skill dir.
  const skillDirUri = entry.uri.replace(/\/SKILL\.md$/, '');
  const dir = await directoryRead(client, skillDirUri);
  check(`resources/directory/read lists direct children of ${skillDirUri}`, dir.resources.length > 0, `${dir.resources.length} children`);
  check('directory listing includes SKILL.md as a direct child', dir.resources.some((r) => r.uri === entry.uri));
  check(
    'resources/directory/read carries ttlMs + cacheScope (CacheableResult, 2026-07-28)',
    Number.isInteger(dir.ttlMs) && (dir.cacheScope === 'public' || dir.cacheScope === 'private'),
    `ttlMs=${dir.ttlMs} cacheScope=${dir.cacheScope}`,
  );

  // directory/read on a non-directory MUST be an error (-32602).
  let errored = false;
  try {
    await directoryRead(client, 'skill://nonexistent/nope');
  } catch (err) {
    errored = true;
    const code = (err as { code?: number }).code;
    check('directory/read on unknown URI errors with -32602', code === -32602, `code=${code}`);
  }
  if (!errored) check('directory/read on unknown URI errors with -32602', false, 'no error thrown');

  // Cursor scope: the adversarial overflow cursor is fixture-scoped, so a crafted
  // cursor on an unknown directory MUST still error (in BOTH profiles), and in the
  // faithful profile a crafted skills/list cursor MUST NOT conjure synthetic entries
  // that skills/get and resources/read cannot satisfy.
  let cursorErrored = false;
  try {
    await directoryRead(client, 'skill://nonexistent/nope', 'adv-overflow-1');
  } catch (err) {
    cursorErrored = true;
    const code = (err as { code?: number }).code;
    check('directory/read on unknown URI + crafted overflow cursor errors with -32602', code === -32602, `code=${code}`);
  }
  if (!cursorErrored) check('directory/read on unknown URI + crafted overflow cursor errors with -32602', false, 'no error thrown');

  if (!adversarial) {
    const crafted = await skillsList(client, 'adv-overflow-1');
    check(
      'crafted overflow cursor in faithful mode yields no synthetic entries and no nextCursor',
      !crafted.nextCursor && crafted.skills.every((s) => !s.uri.includes('adv-enumeration-exhaustion')),
      `${crafted.skills.length} skills, nextCursor=${String(crafted.nextCursor)}`,
    );
  }

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

/**
 * The SDK's host-side `SkillsClient` against the faithful profile: it refuses any entry
 * that breaks the stable spec's structural rules and verifies every read against the
 * entry (size, digest, and SKILL.md frontmatter), so a pass here is a second, independent
 * conformance check of the catalog.
 */
async function runSkillsClientChecks(client: Client): Promise<void> {
  process.stdout.write('\n== SDK SkillsClient verification (faithful profile) ==\n');
  const skills = new SkillsClient(client);
  check('SkillsClient sees the extension', skills.supported);
  check('SkillsClient sees directoryRead', skills.directoryRead);

  // list() throws on any invalid entry.
  const listing = await skills.list();
  check('SkillsClient.list accepts every entry', listing.invalid.length === 0, `${listing.skills.length} skills`);
  const entry = listing.skills.find((s) => Array.isArray(s.resources) && s.resources.length > 1) ?? listing.skills[0];
  if (!entry) {
    check('a skill to verify exists', false);
    return;
  }

  const got = await skills.get(entry.uri);
  check('SkillsClient.get returns the listed entry', JSON.stringify(got.skill) === JSON.stringify(entry));

  // read() verifies size + digest, and for SKILL.md the frontmatter against the entry.
  const manifest = await skills.read(entry);
  check(`SkillsClient.read verifies SKILL.md (${entry.uri})`, manifest.verified && manifest.frontmatter !== undefined);
  const supporting = Array.isArray(entry.resources) ? entry.resources.find((r) => r.uri !== entry.uri) : undefined;
  if (supporting) {
    const file = await skills.read(entry, supporting.uri);
    check(`SkillsClient.read verifies a supporting file (${supporting.uri})`, file.verified && file.bytes.byteLength === supporting.size);
  }

  if (skills.directoryRead) {
    const dir = await skills.readDirectory(entry.uri.replace(/\/SKILL\.md$/, ''));
    check('SkillsClient.readDirectory lists SKILL.md', dir.resources.some((r) => r.uri === entry.uri));
  }
}

/**
 * What the SDK host does with the adversarial profile. `list()` walks every page, so the
 * endless adv-enumeration-exhaustion listing runs into the client's `listMaxPages` bound
 * before any entry is judged; `get()` validates one entry at a time, so it is called for
 * every first-page URI and the rule each refused fixture breaks is printed.
 */
async function runSkillsClientAdversarial(client: Client): Promise<void> {
  process.stdout.write('\n== SDK SkillsClient against the adversarial profile ==\n');
  const skills = new SkillsClient(client);
  let bounded = '';
  try {
    await skills.list();
  } catch (err) {
    bounded = (err as Error).message.split('\n')[0];
  }
  check('SkillsClient bounds the endless listing', bounded !== '', bounded);

  const page = await skillsList(client);
  let refused = 0;
  for (const s of page.skills) {
    try {
      await skills.get(s.uri);
    } catch (err) {
      refused++;
      process.stdout.write(`  refused ${s.uri}: ${(err as Error).message.split('\n')[0]}\n`);
    }
  }
  check('SkillsClient.get refuses at least one fixture entry', refused > 0, `${refused} of ${page.skills.length} first-page entries refused`);
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
    if (Array.isArray(s.resources)) for (const r of s.resources) servedUris.add(r.uri);
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
      const dir = await directoryRead(client, escRoot);
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

    // The same fixture's directory reads also paginate without end.
    const root = 'skill://adv-enumeration-exhaustion';
    const dr0 = await directoryRead(client, root);
    let dcursor = dr0.nextCursor;
    let dpages = 0;
    while (dcursor && dpages < CAP) {
      const dn = await directoryRead(client, root, dcursor);
      dcursor = dn.nextCursor;
      dpages++;
    }
    check(
      `enumeration-exhaustion: resources/directory/read still paginating after ${CAP} extra pages`,
      dpages === CAP && !!dcursor,
      'both enumeration surfaces are unbounded',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  wire = args.adversarial ? LOOSE_WIRE : STRICT_WIRE;
  process.stdout.write(
    `skills-over-mcp smoke client (${args.http ? 'http' : 'stdio'}${args.adversarial ? ', adversarial' : ''}${args.legacy ? ', legacy 2025-11-25' : ''})\n`,
  );
  const client = await connect(args);
  try {
    await runCoreChecks(client, args);
    if (args.adversarial) {
      await runAdversarialReport(client);
      await runSkillsClientAdversarial(client);
    } else {
      await runSkillsClientChecks(client);
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
