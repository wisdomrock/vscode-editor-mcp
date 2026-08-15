import * as vscode from 'vscode';
import { readConfig } from '../config';
import { DiscoveryFile } from '../discovery';
import { log } from '../log';
import { McpHttpServer, type ServerAddress } from './httpServer';

export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

export interface ServerStatus {
  state: ServerState;
  address?: ServerAddress;
  sessions: number;
  writeEnabled: boolean;
  error?: string;
}

/** Owns the server lifecycle and is the single source of truth for UI state. */
export class ServerController implements vscode.Disposable {
  private server: McpHttpServer | undefined;
  private discovery: DiscoveryFile | undefined;
  private state: ServerState = 'stopped';
  private lastError: string | undefined;
  private sessionSub: vscode.Disposable | undefined;
  private starting: Promise<void> | undefined;

  private readonly emitter = new vscode.EventEmitter<ServerStatus>();
  readonly onDidChangeStatus = this.emitter.event;

  constructor(private readonly version: string) {}

  get status(): ServerStatus {
    return {
      state: this.state,
      address: this.server?.getAddress(),
      sessions: this.server?.sessionCount ?? 0,
      writeEnabled: readConfig().allowWrite,
      error: this.lastError,
    };
  }

  async start(): Promise<void> {
    // Guard against the command being fired twice before the listener binds.
    if (this.starting) return this.starting;
    if (this.state === 'running') {
      log.info('Start requested but server is already running');
      return;
    }

    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const config = readConfig();
    this.setState('starting');
    this.lastError = undefined;

    try {
      const server = new McpHttpServer({
        host: config.host,
        port: config.port,
        requireAuth: config.requireAuth,
        allowWrite: config.allowWrite,
        maxFileBytes: config.maxFileBytes,
        sessionIdleMs: config.sessionIdleMs,
        version: this.version,
      });

      const address = await server.start();
      this.server = server;
      this.sessionSub = server.onDidChangeSessions(() => this.emitter.fire(this.status));

      this.discovery = new DiscoveryFile(config.discoveryDir);
      await this.discovery.write({
        url: address.url,
        host: address.host,
        port: address.port,
        token: address.token,
        authRequired: config.requireAuth,
        writeEnabled: config.allowWrite,
        startedAt: new Date().toISOString(),
      });

      this.setState('running');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.error(`Failed to start: ${this.lastError}`);
      // Leave nothing half-initialised behind for the next start attempt.
      await this.cleanup();
      this.setState('error');
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    await this.cleanup();
    this.setState('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async cleanup(): Promise<void> {
    this.sessionSub?.dispose();
    this.sessionSub = undefined;

    await this.discovery?.remove();
    this.discovery = undefined;

    await this.server?.stop();
    this.server?.dispose();
    this.server = undefined;
  }

  private setState(state: ServerState): void {
    this.state = state;
    this.emitter.fire(this.status);
  }

  dispose(): void {
    // Best effort: VS Code does not wait on async disposal, but removing the
    // discovery file matters more than a clean socket teardown.
    void this.cleanup();
    this.emitter.dispose();
  }
}
