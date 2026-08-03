/**
 * server.ts — Construct the low-level MCP Server, advertise the Skills extension
 * capability, and register handlers for resources/list, resources/read, and the
 * custom resources/directory/read method (SEP-2640).
 *
 * We use the low-level `Server` (not `McpServer`) because we need:
 *   - a custom URI scheme (skill://) on resources/read,
 *   - a custom JSON-RPC method (resources/directory/read) with a Zod schema,
 *   - a custom extension capability in the initialize response.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ResourceRegistry, type RegistryOptions } from './resources.js';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
export const DIRECTORY_READ_METHOD = 'resources/directory/read';
export const SKILLS_LIST_METHOD = 'skills/list';
export const SKILLS_GET_METHOD = 'skills/get';

/**
 * Custom request schemas. The SDK's low-level setRequestHandler matches on the
 * `method` literal, so any Zod object with a literal `method` works as a custom
 * JSON-RPC method.
 */
export const DirectoryReadRequestSchema = z.object({
  method: z.literal(DIRECTORY_READ_METHOD),
  params: z.object({
    uri: z.string(),
    cursor: z.string().optional(),
  }),
});

export const SkillsListRequestSchema = z.object({
  method: z.literal(SKILLS_LIST_METHOD),
  params: z.object({ cursor: z.string().optional() }).optional(),
});

export const SkillsGetRequestSchema = z.object({
  method: z.literal(SKILLS_GET_METHOD),
  params: z.object({ uri: z.string() }),
});

export interface BuildServerResult {
  server: Server;
  registry: ResourceRegistry;
}

/**
 * Build a Server. Pass a pre-built `registry` to reuse one across many transports
 * (the HTTP path builds the registry once at startup and shares it across the
 * stateless per-request servers, which also keeps archive bytes/digests stable).
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
          [SKILLS_EXTENSION]: { directoryRead: true },
        },
      },
      instructions:
        'Serves the dangerous-skills corpus (MIT, gricha) as skill:// resources per SEP-2640. ' +
        'Use skills/list to enumerate skills and skills/get to fetch one entry by URI; ' +
        'resources/read any skill:// URI; resources/directory/read lists a directory\'s ' +
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
  // is no skill://index.json.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: registry.listResources() };
  });

  // resources/read — text for text files, base64 blob for binaries/archives.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const read = registry.readResource(uri);
    if (!read) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    if (read.isText) {
      return {
        contents: [{ uri, mimeType: read.mimeType, text: read.bytes.toString('utf8') }],
      };
    }
    return {
      contents: [{ uri, mimeType: read.mimeType, blob: read.bytes.toString('base64') }],
    };
  });

  // skills/list — enumerate skill entries (uri + frontmatter + per-file resources).
  server.setRequestHandler(SkillsListRequestSchema, async (request) => {
    const page = registry.skillsList(request.params?.cursor);
    const result: { skills: typeof page.skills; nextCursor?: string } = { skills: page.skills };
    if (page.nextCursor) result.nextCursor = page.nextCursor;
    return result;
  });

  // skills/get — the entry for one skill by its SKILL.md URI (listed or not).
  server.setRequestHandler(SkillsGetRequestSchema, async (request) => {
    const entry = registry.skillsGet(request.params.uri);
    if (!entry) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${request.params.uri}`);
    }
    return { skill: entry };
  });

  // resources/directory/read — direct children of a directory URI (non-recursive).
  server.setRequestHandler(DirectoryReadRequestSchema, async (request) => {
    // The SEP says directory URIs are *written* without a trailing slash; it does
    // not require rejecting a client that supplies one. Be lenient: normalize a
    // trailing slash before lookup rather than erroring on it.
    const uri = request.params.uri.replace(/\/+$/, '');
    const page = registry.directoryPage(uri, request.params.cursor);
    if (!page) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown directory or not a directory: ${uri}`);
    }
    // Faithful directories return all children in one page (no cursor). The
    // adv-enumeration-exhaustion skill's directory paginates without end.
    const result: { resources: typeof page.resources; nextCursor?: string } = { resources: page.resources };
    if (page.nextCursor) result.nextCursor = page.nextCursor;
    return result;
  });

  return { server, registry };
}
