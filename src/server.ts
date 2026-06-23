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

/**
 * Custom request schema for resources/directory/read. The SDK's low-level
 * setRequestHandler matches on the `method` literal in this schema, so any
 * Zod object with a literal `method` works as a custom JSON-RPC method.
 */
export const DirectoryReadRequestSchema = z.object({
  method: z.literal(DIRECTORY_READ_METHOD),
  params: z.object({
    uri: z.string(),
    cursor: z.string().optional(),
  }),
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
        'Use skill://index.json to enumerate skills; resources/read any skill:// URI; ' +
        'resources/directory/read lists a directory\'s direct children. ' +
        (opts.adversarial
          ? 'ADVERSARIAL PROFILE ACTIVE: adv-* and refunds fixtures are intentionally SEP-violating.'
          : ''),
    },
  );

  // resources/list — enumerate everything (index + SKILL.mds + supporting files + archives).
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

  // resources/directory/read — direct children of a directory URI (non-recursive).
  server.setRequestHandler(DirectoryReadRequestSchema, async (request) => {
    // The SEP says directory URIs are *written* without a trailing slash; it does
    // not require rejecting a client that supplies one. Be lenient: normalize a
    // trailing slash before lookup rather than erroring on it.
    const uri = request.params.uri.replace(/\/+$/, '');
    const children = registry.directoryChildren(uri);
    if (!children) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown directory or not a directory: ${uri}`);
    }
    // Pagination: echo any incoming cursor as a no-op; never set nextCursor since
    // we return all direct children in one page. The field is supported in shape.
    const result: { resources: typeof children; nextCursor?: string } = { resources: children };
    return result;
  });

  return { server, registry };
}
