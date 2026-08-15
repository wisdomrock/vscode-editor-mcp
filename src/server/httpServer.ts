import * as http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from '../log';
import type { ToolContext } from '../tools/context';
import { createMcpServer } from './mcpServer';

export const MCP_PATH = '/mcp';

export interface HttpServerOptions extends ToolContext {
  host: string;
  port: number;
  requireAuth: boolean;
  version: string;
  /** Drop sessions with no request activity for this long. 0 disables reaping. */
  sessionIdleMs?: number;
}

const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

export interface ServerAddress {
  host: string;
  port: number;
  url: string;
  token: string | null;
}

/**
 * Loopback Streamable HTTP endpoint for the MCP server. One instance per VS Code
 * window; each connecting client gets its own session with its own McpServer, all
 * sharing this window's `vscode` API.
 */
export class McpHttpServer {
  private http: http.Server | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly token: string;
  private address: ServerAddress | undefined;
  private reaper: NodeJS.Timeout | undefined;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the session count changes, so the status bar can refresh. */
  readonly onDidChangeSessions = this.changeEmitter.event;

  constructor(private readonly options: HttpServerOptions) {
    this.token = randomBytes(32).toString('base64url');
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get listening(): boolean {
    return this.http?.listening === true;
  }

  getAddress(): ServerAddress | undefined {
    return this.address;
  }

  async start(): Promise<ServerAddress> {
    if (this.http) throw new Error('server already started');

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(err => {
        log.error(`Unhandled request error: ${String(err)}`);
        if (!res.headersSent) json(res, 500, { error: 'internal error' });
        else res.end();
      });
    });
    this.http = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`port ${this.options.port} is already in use; set vscodeEditorMcp.port to 0 to auto-assign`)
            : err,
        );
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port, this.options.host);
    });

    // Keeping the listener unref'd is wrong here: we want it to hold the loop
    // open for as long as the extension host lives, and deactivate() closes it.
    server.on('error', err => log.error(`HTTP server error: ${String(err)}`));

    const { port } = server.address() as AddressInfo;
    const displayHost = this.options.host === '::1' ? '[::1]' : this.options.host;
    this.address = {
      host: this.options.host,
      port,
      url: `http://${displayHost}:${port}${MCP_PATH}`,
      token: this.options.requireAuth ? this.token : null,
    };

    this.startReaper();

    log.info(`Listening on ${this.address.url} (auth ${this.options.requireAuth ? 'on' : 'off'}, write ${this.options.allowWrite ? 'on' : 'off'})`);
    return this.address;
  }

  /**
   * The MCP client transport does not send DELETE on close — only an explicit
   * terminateSession() does. Without this, a client that exits or crashes leaves
   * its session allocated forever and the connection count reads high.
   */
  private startReaper(): void {
    const idleMs = this.options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
    if (idleMs <= 0) return;

    this.reaper = setInterval(() => {
      const cutoff = Date.now() - idleMs;
      for (const [id, session] of this.sessions) {
        if (session.lastActivity > cutoff) continue;
        log.info(`Reaping session ${id.slice(0, 8)} after ${Math.round(idleMs / 60000)}m idle`);
        void this.closeSession(id, session);
      }
    }, Math.min(REAP_INTERVAL_MS, idleMs));

    // Must not keep the extension host's event loop alive on its own.
    this.reaper.unref();
  }

  private async closeSession(id: string, session: Session): Promise<void> {
    this.dropSession(id);
    try {
      await session.transport.close();
      await session.server.close();
    } catch (err) {
      log.warn(`Error closing session ${id.slice(0, 8)}: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    const server = this.http;
    this.http = undefined;
    this.address = undefined;

    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }

    await Promise.all(
      [...this.sessions.values()].map(async s => {
        try {
          await s.transport.close();
          await s.server.close();
        } catch (err) {
          log.warn(`Error closing session: ${String(err)}`);
        }
      }),
    );
    this.sessions.clear();
    this.changeEmitter.fire();

    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      // close() stops new connections but lets idle keep-alives linger.
      server.closeAllConnections?.();
    }
    log.info('Server stopped');
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Unauthenticated liveness probe. Deliberately reveals nothing but the name,
    // so a client can confirm a discovery file points at the right process.
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { server: 'vscode-editor-mcp', version: this.options.version });
    }

    if (url.pathname !== MCP_PATH) return json(res, 404, { error: 'not found' });

    const rejection = this.checkSecurity(req);
    if (rejection) {
      log.warn(`Rejected ${req.method} from ${req.socket.remoteAddress}: ${rejection.reason}`);
      return json(res, rejection.status, { error: rejection.reason });
    }

    const sessionId = header(req, 'mcp-session-id');

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return json(res, 404, { error: 'unknown session' });
      session.lastActivity = Date.now();
      return session.transport.handleRequest(req, res);
    }

    if (req.method !== 'POST') {
      return json(res, 400, { error: 'mcp-session-id header required for this method' });
    }

    return this.openSession(req, res);
  }

  /** Handles the initialize request that has no session yet. */
  private async openSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session: Partial<Session> = { lastActivity: Date.now() };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        this.sessions.set(id, session as Session);
        log.info(`Client connected (session ${id.slice(0, 8)}, ${this.sessions.size} active)`);
        this.changeEmitter.fire();
      },
      onsessionclosed: id => this.dropSession(id),
    });

    const server = createMcpServer(
      { maxFileBytes: this.options.maxFileBytes, allowWrite: this.options.allowWrite },
      this.options.version,
    );

    session.transport = transport;
    session.server = server;

    transport.onclose = () => {
      if (transport.sessionId) this.dropSession(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  private dropSession(id: string): void {
    if (!this.sessions.delete(id)) return;
    log.info(`Client disconnected (session ${id.slice(0, 8)}, ${this.sessions.size} active)`);
    this.changeEmitter.fire();
  }

  /**
   * Three independent gates. Host and Origin defend against DNS rebinding — a page
   * in the user's browser resolving an attacker domain to 127.0.0.1 and POSTing here.
   * The bearer token defends against every other local process.
   */
  private checkSecurity(req: http.IncomingMessage): { status: number; reason: string } | undefined {
    const host = header(req, 'host');
    if (host && !isLoopbackHost(host)) {
      return { status: 403, reason: 'Host header is not a loopback address' };
    }

    const origin = header(req, 'origin');
    if (origin && !this.isAllowedOrigin(origin)) {
      return { status: 403, reason: 'Origin not allowed' };
    }

    if (this.options.requireAuth && !this.hasValidToken(req)) {
      return { status: 401, reason: 'missing or invalid bearer token' };
    }

    return undefined;
  }

  private isAllowedOrigin(origin: string): boolean {
    try {
      const parsed = new URL(origin);
      const port = this.address?.port;
      return isLoopbackHost(parsed.host) && (port === undefined || parsed.port === String(port));
    } catch {
      return false;
    }
  }

  private hasValidToken(req: http.IncomingMessage): boolean {
    const auth = header(req, 'authorization') ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice('bearer '.length).trim()
      : (header(req, 'x-mcp-token') ?? '');

    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function isLoopbackHost(hostHeader: string): boolean {
  // Strip the port; IPv6 literals arrive as "[::1]:1234".
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
