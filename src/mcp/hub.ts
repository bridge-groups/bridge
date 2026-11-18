import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

/** What one agent turn is allowed to do, keyed by the token in its MCP URL. */
export interface SessionGrant {
  sessionKey: string;
  agent: string;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** The bridge-side behaviour behind each MCP tool. */
export interface HubBackend {
  listTools(grant: SessionGrant): Promise<Tool[]>;
  callTool(grant: SessionGrant, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * The bridge's MCP endpoints. Each agent turn gets its own URL (`<base>/mcp/<token>`), so every tool call is
 * tied to the session that made it and nothing else. Served by whatever HTTP server the bridge is mounted on.
 */
export class McpHub {
  private readonly grants = new Map<string, SessionGrant>();
  private readonly backend: HubBackend;
  /** Where agents reach the endpoints, without a trailing slash. */
  private readonly baseUrl: () => string;

  constructor(backend: HubBackend, baseUrl: () => string) {
    this.backend = backend;
    this.baseUrl = baseUrl;
  }

  grant(g: SessionGrant): { url: string; token: string; revoke: () => void } {
    const token = randomBytes(18).toString('base64url');
    this.grants.set(token, g);
    return { url: `${this.baseUrl()}/mcp/${token}`, token, revoke: () => this.grants.delete(token) };
  }

  /** Serve `/mcp/<token>` (path relative to where the bridge is mounted); false for any other path. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(path);
    if (!m) return false;
    const grant = this.grants.get(m[1]!);
    if (!grant) {
      res.writeHead(404).end();
      return true;
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;

    // Stateless: a fresh MCP server per request, bound to this grant.
    const server = new Server({ name: 'bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.backend.listTools(grant) }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      try {
        const out = await this.backend.callTool(grant, r.params.name, r.params.arguments ?? {});
        return { content: [{ type: 'text', text: out.text }], isError: out.isError ?? false };
      } catch (err) {
        return { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return true;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : undefined;
}
