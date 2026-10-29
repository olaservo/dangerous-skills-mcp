/**
 * server.ts — Construct the low-level MCP Server, advertise the Skills extension
 * capability, and register handlers for resources/list, resources/read, and the
 * extension methods skills/list, skills/get and resources/directory/read (SEP-2640,
 * stable Skills extension spec, base protocol revision 2026-07-28).
 *
 * We use the low-level `Server` (not `McpServer`) because we need:
 *   - a custom URI scheme (skill://) on resources/read,
 *   - custom JSON-RPC methods (skills/list, skills/get, resources/directory/read)
 *     with Zod schemas,
 *   - a custom extension capability in the server capabilities.
 *
 * The SDK's own `SkillsExtension` (`@modelcontextprotocol/server/ext/skills`) is not
 * used on purpose: it validates every entry it serves and drops invalid ones, and the
 * adversarial profile exists to put spec-violating entries on the wire. The handlers
 * stay hand-rolled; the wire constants, request-params schemas and the pieces of the
 * result schemas that are identical come from `@modelcontextprotocol/core/ext/skills`.
 *
 * A fresh Server is built per serving unit (one stdio connection, one HTTP request)
 * by the SDK entries `serveStdio` / `createMcpHandler`, which own the protocol-era
 * decision: 2026-07-28 for modern clients, 2025-era `initialize` for legacy ones. The
 * (expensive) ResourceRegistry is built once and shared across those instances.
 */
import {
  GetSkillRequestParamsSchema,
  ListSkillsRequestParamsSchema,
  ReadResourceDirectoryRequestParamsSchema,
  ReadResourceDirectoryResultSchema,
  RESOURCES_DIRECTORY_READ_METHOD,
  SkillCacheScopeSchema,
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
} from '@modelcontextprotocol/core/ext/skills';
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ResourceRegistry, type RegistryOptions } from './resources.js';

export { RESOURCES_DIRECTORY_READ_METHOD, SKILLS_EXTENSION_ID, SKILLS_GET_METHOD, SKILLS_LIST_METHOD };

/**
 * Read-buffer cap for the stdio transport, in bytes.
 *
 * SDK v2 caps the stdio read buffer at 10 MiB by default (v1 buffered unbounded) and
 * closes the connection when a single message would exceed it. Several adversarial
 * fixtures are deliberately larger than that — `adv-oversized-payload` is a 16 MiB body
 * and `adv-walk-budget` serves 3 x 9 MiB files, both of which grow further once
 * base64-encoded into a JSON-RPC frame — so the default cap would make them unreadable
 * over stdio, the repo's documented default transport. Serving oversized payloads is the
 * point of those fixtures, so raise the cap rather than shrink the corpus.
 *
 * Both ends must agree: the server writes the frame, the client reads it.
 */
export const STDIO_MAX_BUFFER_SIZE = 64 * 1024 * 1024;

/**
 * Cache hint stamped on every CacheableResult this server emits (`skills/list`,
 * `skills/get`, `resources/directory/read`, `resources/list`, `resources/read`). The spec makes `ttlMs` and
 * `cacheScope` REQUIRED on those results at 2026-07-28; they are a freshness hint and
 * a cache-scope marker, never an integrity property — digests/sizes govern content.
 * The corpus is static and unauthenticated, so it is `public` with a 5-minute TTL.
 */
export const CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' } as const;

const CacheableFields = {
  ttlMs: z.number().int().nonnegative(),
  cacheScope: SkillCacheScopeSchema,
};

/**
 * The SDK registers a non-spec method with `setRequestHandler(method, { params, result? },
 * handler)`: `request.params` is validated against the params schema and the handler
 * receives the parsed params; the result schema only types the return value. The params
 * schemas are the SDK's own (the same ones its SkillsExtension registers).
 *
 * The skills/list and skills/get result schemas stay local. The SDK's `SkillSchema`
 * requires a string `name` and `description` in `frontmatter` and a well-formed
 * `sha256:` digest on every resource; the adversarial profile must be able to put an
 * entry on the wire that breaks those rules, so the local schemas type the entry as the
 * permissive superset. The directory-read result uses the SDK's schema: nothing a
 * fixture emits for it is outside the ordinary Resource shape.
 */

/** Spec `SkillResource` (permissive: the digest is any string). */
export const SkillResourceSchema = z.object({
  uri: z.string(),
  digest: z.string(),
  size: z.number().int().nonnegative(),
});

/** Spec `Skill` entry (permissive frontmatter). `resources` is REQUIRED: the complete array or "dynamic". */
export const SkillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.array(SkillResourceSchema), z.literal('dynamic')]),
});

/** Spec `ListSkillsResult extends PaginatedResult, CacheableResult`. */
export const SkillsListResultSchema = z.object({
  resultType: z.literal('complete'),
  skills: z.array(SkillEntrySchema),
  nextCursor: z.string().optional(),
  ...CacheableFields,
});

/** Spec `GetSkillResult extends CacheableResult` (no cursor). */
export const SkillsGetResultSchema = z.object({
  resultType: z.literal('complete'),
  skill: SkillEntrySchema,
  ...CacheableFields,
});

export interface BuildServerResult {
  server: Server;
  registry: ResourceRegistry;
}

/**
 * Build a Server. Pass a pre-built `registry` to reuse one across many instances
 * (both entries build the registry once at startup and share it across the
 * per-connection / per-request servers, which also keeps archive bytes/digests stable).
 */
export async function buildServer(
  opts: RegistryOptions = {},
  registry?: ResourceRegistry,
): Promise<BuildServerResult> {
  registry = registry ?? (await ResourceRegistry.build(opts));

  const server = new Server(
    {
      name: 'skills-over-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: { listChanged: false },
        // SEP-2640 extension capability: advertise directoryRead support.
        extensions: {
          [SKILLS_EXTENSION_ID]: { directoryRead: true },
        },
      },
      // Server-level hint for the standard cacheable results. Our handlers also set
      // the fields explicitly, so this only matters for results the SDK builds itself.
      cacheHints: {
        'resources/list': CACHE_HINT,
        'resources/read': CACHE_HINT,
      },
      instructions:
        'Serves the dangerous-skills corpus (MIT, gricha) as skill:// resources per SEP-2640. ' +
        'Use skills/list to enumerate skills and skills/get to fetch one entry by URI; ' +
        "resources/read any skill:// URI; resources/directory/read lists a directory's " +
        'direct children. NOTE: archive distribution is a DEFERRED feature, not part of the ' +
        'v1 SEP; any archive blobs served here are retained for the deferred-feature research ' +
        'corpus and never appear in a skills/list entry. ' +
        (opts.adversarial
          ? 'ADVERSARIAL PROFILE ACTIVE: adv-* and refunds fixtures are intentionally SEP-violating.'
          : ''),
    },
  );

  // resources/list — enumerate readable resources (SKILL.mds + supporting files +
  // any deferred-fixture archive blobs). Enumeration of skills is skills/list; there
  // is no skill://index.json. CacheableResult at 2026-07-28: carry ttlMs/cacheScope
  // explicitly (the SDK would otherwise fill ttlMs: 0 / cacheScope: private).
  server.setRequestHandler('resources/list', async () => {
    return { resources: registry.listResources(), ...CACHE_HINT };
  });

  // resources/read — text for text files, base64 blob for binaries/archives.
  // CacheableResult at 2026-07-28 (ttlMs/cacheScope); the SDK stamps resultType.
  server.setRequestHandler('resources/read', async (request) => {
    const uri = request.params.uri;
    const read = registry.readResource(uri);
    if (!read) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    if (read.isText) {
      return {
        contents: [{ uri, mimeType: read.mimeType, text: read.bytes.toString('utf8') }],
        ...CACHE_HINT,
      };
    }
    return {
      contents: [{ uri, mimeType: read.mimeType, blob: read.bytes.toString('base64') }],
      ...CACHE_HINT,
    };
  });

  // skills/list — enumerate skill entries (uri + frontmatter + per-file resources).
  // Custom (extension) method: the SDK only fills cache fields on the base protocol's
  // own cacheable methods, so resultType/ttlMs/cacheScope are set here explicitly.
  server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: ListSkillsRequestParamsSchema, result: SkillsListResultSchema },
    async (params) => {
      const page = registry.skillsList(params.cursor);
      const result: z.infer<typeof SkillsListResultSchema> = {
        resultType: 'complete',
        skills: page.skills,
        ...CACHE_HINT,
      };
      if (page.nextCursor) result.nextCursor = page.nextCursor;
      return result;
    },
  );

  // skills/get — the entry for one skill by its SKILL.md URI (listed or not).
  server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: GetSkillRequestParamsSchema, result: SkillsGetResultSchema },
    async (params) => {
      const entry = registry.skillsGet(params.uri);
      if (!entry) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${params.uri}`);
      }
      return { resultType: 'complete' as const, skill: entry, ...CACHE_HINT };
    },
  );

  // resources/directory/read — direct children of a directory URI (non-recursive).
  // Custom (non-spec) method: the 3-arg form takes the method name plus explicit
  // params/result schemas, and the handler receives the PARSED PARAMS (not the
  // `{ method, params }` envelope). Request metadata lives on `ctx.mcpReq._meta`.
  // The spec's ReadResourceDirectoryResult extends CacheableResult, so the result
  // carries ttlMs/cacheScope like the other two methods.
  server.setRequestHandler(
    RESOURCES_DIRECTORY_READ_METHOD,
    { params: ReadResourceDirectoryRequestParamsSchema, result: ReadResourceDirectoryResultSchema },
    async (params) => {
      // The SEP says directory URIs are *written* without a trailing slash; it does
      // not require rejecting a client that supplies one. Be lenient: normalize a
      // trailing slash before lookup rather than erroring on it.
      const uri = params.uri.replace(/\/+$/, '');
      const page = registry.directoryPage(uri, params.cursor);
      if (!page) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown directory or not a directory: ${uri}`);
      }
      // Faithful directories return all children in one page (no cursor). The
      // adv-enumeration-exhaustion skill's directory paginates without end.
      const result: z.infer<typeof ReadResourceDirectoryResultSchema> & { resultType: 'complete' } = {
        resultType: 'complete',
        resources: page.resources,
        ...CACHE_HINT,
      };
      if (page.nextCursor) result.nextCursor = page.nextCursor;
      return result;
    },
  );

  return { server, registry };
}
