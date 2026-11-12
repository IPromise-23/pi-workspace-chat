import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type RecordValue = Record<string, unknown>;
export type Invocation = { command: string; env: NodeJS.ProcessEnv; cwd: string };
export const object = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

export class RpcError extends Error {
  constructor(readonly kind: 'spawn' | 'closed' | 'timeout' | 'protocol' | 'rejected' | 'shutdown',
    readonly command?: string, readonly detail?: string) {
    super(kind);
    this.name = 'RpcError';
  }
}

export class JsonLines {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private readonly maxChars = 32 * 1024 * 1024) {}
  push(chunk: Buffer, emit: (record: RecordValue) => void) {
    this.buffer += this.decoder.write(chunk);
    let start = 0;
    let lf: number;
    while ((lf = this.buffer.indexOf('\n', start)) !== -1) {
      if (lf - start > this.maxChars) throw new RpcError('protocol');
      const line = this.buffer.slice(start, lf);
      start = lf + 1;
      if (!line.trim()) continue;
      const record = object(JSON.parse(line));
      if (typeof record.type !== 'string') throw new RpcError('protocol');
      emit(record);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxChars) throw new RpcError('protocol');
  }
}

type Pending = { command: string; resolve: (value: unknown) => void;
  reject: (reason: RpcError) => void; timer?: NodeJS.Timeout };

export class PiRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly closed: Promise<void>;
  private stopped = false;
  private requestedClose = false;
  private fatal?: RpcError;
  private shutdown?: Promise<void>;

  constructor(invocation: Invocation, sessionPath: string | undefined,
    private readonly onEvent: (record: RecordValue) => void,
    private readonly onExit: (error: RpcError) => void) {
    this.child = spawn(invocation.command, ['--mode', 'rpc', ...(sessionPath ? ['--session', sessionPath] : [])], {
      cwd: invocation.cwd, env: invocation.env, stdio: 'pipe', shell: false, windowsHide: true,
    });
    this.closed = new Promise(resolve => this.child.once('close', () => {
      this.stopped = true;
      const error = this.fatal ?? new RpcError('closed');
      for (const id of this.pending.keys()) this.finish(id)?.reject(error);
      resolve();
      if (!this.requestedClose || this.fatal) this.onExit(error);
    }));
    this.child.on('error', () => {
      if (this.child.pid === undefined) this.fatal ??= new RpcError('spawn');
    });
    this.child.stdin.on('error', () => {
      for (const id of this.pending.keys()) this.finish(id)?.reject(new RpcError('closed'));
    });
    // Drain stderr without storing it; user extensions may log secrets.
    this.child.stderr.resume();
    const lines = new JsonLines();
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.fatal) return;
      try { lines.push(chunk, record => this.receive(record)); }
      catch {
        this.fatal = new RpcError('protocol');
        for (const id of this.pending.keys()) this.finish(id)?.reject(this.fatal);
        void this.stop().catch(() => {});
      }
    });
  }

  get isClosed() { return this.stopped; }

  private finish(id: string) {
    const item = this.pending.get(id);
    if (item) {
      this.pending.delete(id);
      clearTimeout(item.timer);
    }
    return item;
  }

  private receive(record: RecordValue) {
    if (record.type !== 'response') { this.onEvent(record); return; }
    if (typeof record.id !== 'string') return;
    const pending = this.finish(record.id);
    if (!pending) return;
    if (record.command !== pending.command) {
      pending.reject(new RpcError('protocol', pending.command));
    } else if (record.success === true) {
      pending.resolve(record.data);
    } else if (record.success === false) {
      pending.reject(new RpcError('rejected', pending.command,
        typeof record.error === 'string' ? record.error.slice(0, 4000) : undefined));
    } else {
      pending.reject(new RpcError('protocol', pending.command));
    }
  }

  request(command: string, fields: RecordValue = {}, timeoutMs = 15_000): Promise<unknown> {
    if (this.stopped || this.requestedClose) return Promise.reject(new RpcError('closed', command));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const pending: Pending = { command, resolve, reject };
      if (timeoutMs > 0) pending.timer = setTimeout(() =>
        this.finish(id)?.reject(new RpcError('timeout', command)), timeoutMs);
      this.pending.set(id, pending);
      try {
        this.child.stdin.write(JSON.stringify({ ...fields, type: command, id }) + '\n', error => {
          if (error) this.finish(id)?.reject(new RpcError('closed', command));
        });
      } catch { this.finish(id)?.reject(new RpcError('closed', command)); }
    });
  }

  respond(id: string, fields: RecordValue) {
    if (this.stopped || this.requestedClose || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ ...fields, type: 'extension_ui_response', id }) + '\n');
  }

  stop(graceMs = 3000) {
    return this.shutdown ??= this.stopOnce(graceMs);
  }

  private async stopOnce(graceMs: number) {
    if (this.stopped) return;
    this.requestedClose = true;
    this.child.stdin.end();
    if (await this.waitClosed(graceMs)) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
    if (await this.waitClosed(graceMs)) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    if (!(await this.waitClosed(graceMs))) throw new RpcError('shutdown');
  }

  private async waitClosed(ms: number) {
    return Promise.race([this.closed.then(() => true), delay(ms, false, { ref: false })]);
  }
}
