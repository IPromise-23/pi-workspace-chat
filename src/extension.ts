import * as vscode from 'vscode';
import { randomUUID, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { LaunchError, probeVersion, resolveInvocation } from './launch';
import { PiRpc, RpcError, object, type Invocation, type RecordValue } from './rpc';
import { arr, bounded, historyRows, messageRow, modelChoice, modelFailure, rec, slashChoices, str, toolCall, toolOutput,
  type ContextChip, type Dialog, type Row, type Snapshot } from './protocol';
import { inside, listSessions, readSession, type Session } from './sessions';

const VIEW = 'piWorkspace.chat';
const PATCH_SCHEME = 'pi-workspace-patch';
const HANDOFF = 'piWorkspace.terminalHandoff';
const ROOT = 'piWorkspace.root';
const PANEL_COMMANDS = new Set(['new', 'resume', 'quit', 'reload']);
// Pi 1.5's public RPC only reports commands registered by resources.
const PI_BUILT_INS = [
  'settings', 'model', 'tree', 'thinking', 'scoped-models', 'export', 'import',
  'share', 'bug', 'copy', 'name', 'session', 'changelog', 'hotkeys', 'fork',
  'clone', 'trust', 'login', 'logout', 'new', 'compact', 'resume', 'reload', 'quit',
];
const BUILT_IN_NAMES = new Set(PI_BUILT_INS);
type Root = { folder: vscode.WorkspaceFolder; cwd: string; key: string };
type Handoff = { name: string; rootKey: string; file?: string; pid?: number };
type Attachment = ContextChip & { value: string };
const zh = () => vscode.env.language.toLowerCase().startsWith('zh');
const l = (en: string, cn: string) => zh() ? cn : en;

export function activate(ctx: vscode.ExtensionContext) {
  const panel = new PiPanel(ctx);
  ctx.subscriptions.push(panel,
    vscode.window.registerWebviewViewProvider(VIEW, panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, {
      provideTextDocumentContent: uri => panel.patchContent(uri.toString()),
    }),
    vscode.window.onDidCloseTerminal(term => void panel.terminalClosed(term).catch(() => {})),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('piWorkspace')) panel.refreshView(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void panel.foldersChanged().catch(() => {}); }),
  );
  const command = (name: string, fn: () => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand('piWorkspace.' + name, fn));
  command('focus', () => vscode.commands.executeCommand(VIEW + '.focus'));
  command('start', () => panel.command('start'));
  command('newSession', () => panel.command('new'));
  command('history', () => panel.command('history'));
  command('addContext', () => panel.attachEditor(vscode.window.activeTextEditor));
  command('terminal', () => panel.command('terminal'));
  command('changeFolder', () => panel.command('folder'));
  command('openSessionFile', () => panel.command('openSession'));
  return { show: () => vscode.commands.executeCommand(VIEW + '.focus') };
}

class PiPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private viewSubs: vscode.Disposable[] = [];
  private client?: PiRpc;
  private invocation?: Invocation;
  private root?: Root;
  private version?: string;
  private phase: Snapshot['phase'] = 'disconnected';
  private notice?: string;
  private settingsHint = false;
  private session?: string;
  private sessionId?: string;
  private sessionFile?: string;
  private model?: Snapshot['model'];
  private thinking?: string;
  private models: Snapshot['models'] = [];
  private levels: string[] = [];
  private slash?: Snapshot['slash'];
  private rows = new Map<string, Row>();
  private context: Attachment[] = [];
  private dialogs = new Map<string, { dialog: Dialog; timer?: NodeJS.Timeout }>();
  private status = new Map<string, string>();
  private extensionTitle?: string;
  private assistant?: string;
  private terminal?: vscode.Terminal;
  private handoff?: Handoff;
  private recentFolderKey?: string;
  private handling = false;
  private acceptedPrompt?: { ended: boolean; acknowledged: boolean };
  private renderTimer?: NodeJS.Timeout;
  private readonly patches = new Map<string, string>();
  private ready = false;
  private disposed = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.handoff = ctx.workspaceState.get(HANDOFF);
    if (this.handoff) this.phase = 'terminal';
    this.recentFolderKey = ctx.workspaceState.get(ROOT);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    const nonce = randomBytes(24).toString('base64');
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media'), vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'),
    ] };
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'style.css'));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    w.html = `<!DOCTYPE html><html lang="${zh() ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${css}"><title>Pi Workspace Chat</title></head>
      <body><main id="app"></main><script nonce="${nonce}" src="${js}"></script></body></html>`;
    this.viewSubs.forEach(d => d.dispose());
    this.viewSubs = [
      w.onDidReceiveMessage(msg => { void this.receive(msg).catch(e => this.report(e)); }),
      view.onDidChangeVisibility(() => { if (view.visible) this.refreshView(); }),
      view.onDidDispose(() => {
        this.ready = false;
        this.view = undefined;
        for (const id of this.dialogs.keys()) this.answer(id, { cancelled: true });
      }),
    ];
  }

  private configuration() { return vscode.workspace.getConfiguration('piWorkspace', this.root?.folder.uri); }
  private snapshot(): Snapshot {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = this.root?.folder.name ?? (folders.length === 1 ? folders[0].name : '');
    const host = vscode.env.remoteName
      ? l('Remote', '远程') + ' · ' + (this.root?.folder.uri.authority.split('+').at(-1) || vscode.env.remoteName)
      : l('Local', '本机');
    const config = this.configuration();
    const panelLabels: Record<string, string> = {
      new: l('Start a new conversation', '新建会话'),
      resume: l('Open conversation history', '打开会话历史'),
      reload: l('Refresh Pi commands', '刷新 Pi 命令'),
      quit: l('Stop Pi and keep the conversation', '停止 Pi，保留会话'),
    };
    const commands: Snapshot['slash'] = PI_BUILT_INS.map(name => ({
      name, description: panelLabels[name] ?? l('Run in the Pi terminal', '在 Pi 终端执行'),
      source: PANEL_COMMANDS.has(name) ? 'panel' : 'terminal',
    }));
    const seen = new Set(BUILT_IN_NAMES);
    for (const source of ['prompt', 'extension', 'skill']) {
      for (const command of this.slash ?? []) {
        if (command.source !== source || seen.has(command.name)) continue;
        commands.push(command);
        seen.add(command.name);
      }
    }
    return { host, folder, hasFolder: folders.length > 0, phase: this.phase,
      version: this.version, notice: this.notice, settingsHint: this.settingsHint, session: this.session,
      model: this.model, thinking: this.thinking, models: this.models, thinkingLevels: this.levels,
      slash: commands, commandsLoaded: this.slash !== undefined,
      context: this.context.map(({ id, label, preview }) => ({ id, label, preview })),
      dialogs: [...this.dialogs.values()].map(d => d.dialog),
      rows: [...this.rows.values()].slice(-180).map(r => ({ ...r, text: bounded(r.text, 12000),
        thinking: r.thinking ? bounded(r.thinking, 8000) : undefined,
        patch: r.patch ? bounded(r.patch, 3000) : undefined })),
      toolExpanded: config.get('expandToolResults', false), modifierSend: config.get('sendWithModifier', false),
      status: [...this.status.values()], extensionTitle: this.extensionTitle };
  }

  refreshView() {
    if (this.renderTimer || !this.ready || !this.view?.visible) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.post({ type: 'snapshot', value: this.snapshot() });
    }, 55);
  }
  private post(data: object) { if (this.view && this.ready) void this.view.webview.postMessage(data); }
  private update(phase?: Snapshot['phase'], notice?: string, settingsHint = false) {
    if (phase) this.phase = phase;
    this.notice = notice;
    this.settingsHint = settingsHint;
    this.refreshView();
  }

  private report(error: unknown) {
    const launch: Record<LaunchError['kind'], string> = {
      unsupported: l('This host platform is not supported yet. Use macOS or Linux.', '此宿主平台尚未支持，请使用 macOS 或 Linux。'),
      missing: l('Pi was not found on this host. Install Pi here or set its executable path.', '此机器找不到 Pi。请在此机器安装 Pi，或指定可执行文件路径。'),
      piPath: l('The configured Pi path is not an executable absolute path.', '设置中的 Pi 路径必须是可执行文件的绝对路径。'),
      nodeDirectory: l('The configured Node directory does not contain an executable node.', '设置中的 Node 目录必须包含可执行的 node。'),
      node: l('Pi did not start. Check that this installation can find Node.js 22.19 or newer.', 'Pi 未能启动。请检查这套 Pi 能否找到 Node.js 22.19 或更新版本。'),
      version: l('Pi 1.5.0 or newer is required for the chat protocol.', '聊天协议需要 Pi 1.5.0 或更新版本。'),
    };
    if (error instanceof LaunchError) this.update(undefined, launch[error.kind], true);
    else if (error instanceof RpcError) {
      const note: Record<RpcError['kind'], string> = {
        spawn: l('The Pi subprocess could not be started.', '无法启动 Pi 子进程。'),
        closed: l('The connection to Pi ended. Reopen the saved session when ready.', 'Pi 连接已结束，可重新打开已保存的会话。'),
        timeout: l('Pi did not respond in time. Check the current session before trying again.', 'Pi 响应超时。重试前请先检查当前会话。'),
        protocol: l('Pi sent an invalid RPC record. Check its version and extensions, or use the terminal.', 'Pi 发出了无效 RPC 记录。请检查版本与扩展，或使用终端。'),
        rejected: error.detail && /no (model|api key|credentials)|not logged|authenti[cz]|sign in/i.test(error.detail)
          ? l('Pi could not use a model. Open the Pi terminal to sign in or choose a model.', 'Pi 无法使用模型，请到 Pi 终端登录或选模型。')
          : l('Pi could not complete this request. Check the session or try the terminal.', 'Pi 未能完成此请求，请检查会话或使用终端。'),
        shutdown: l('Pi has not exited. The session was not handed off.', 'Pi 尚未退出，会话未移交。'),
      };
      this.update(undefined, note[error.kind]);
    } else {
      this.update(undefined, l('This action could not be completed. Check the workspace and try again.', '此操作未完成。请检查工作区后重试。'));
    }
  }

  async command(action: string) {
    await vscode.commands.executeCommand(VIEW + '.focus');
    try { await this.perform(action); } catch (e) { this.report(e); }
  }

  private async receive(value: unknown) {
    const m = rec(value);
    const type = str(m.type);
    if (type === 'ready') { this.ready = true; this.refreshView(); return; }
    if (!vscode.workspace.isTrusted) return;
    if (type === 'stop') { if (this.client && this.phase === 'running') {
      await this.client.request('abort'); this.refreshView();
    } return; }
    if (type === 'dialog') { this.receiveDialog(m); return; }
    if (type === 'detach') {
      this.context = this.context.filter(c => c.id !== m.id);
      this.refreshView(); return;
    }
    if (type === 'attach') { await this.attachEditor(vscode.window.activeTextEditor); return; }
    if (type === 'openFile' || type === 'openPatch') { await this.openRow(type, str(m.id)); return; }
    if (type === 'link') {
      let url: URL;
      try { url = new URL(str(m.href)); } catch { return; }
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        await vscode.env.openExternal(vscode.Uri.parse(url.href));
      }
      return;
    }
    if (type === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ipromise.pi-workspace-chat');
      return;
    }
    if (type === 'openFolder') {
      if (!vscode.workspace.workspaceFolders?.length) {
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
      }
      return;
    }
    if (type === 'prompt') { await this.prompt(str(m.id), str(m.text), m.inTerminal === true); return; }
    if (type === 'model' || type === 'thinking') {
      await this.exclusive(async () => {
        if (!this.client || this.phase !== 'idle') return;
        if (type === 'model') {
          const choice = this.models.find(x => x.provider === m.provider && x.id === m.id);
          if (!choice) return;
          await this.client.request('set_model', { provider: choice.provider, modelId: choice.id });
        } else if (typeof m.level === 'string' && this.levels.includes(m.level)) {
          await this.client.request('set_thinking_level', { level: m.level });
        }
        await this.syncMeta(this.client, true);
      });
      return;
    }
    if (['start', 'new', 'history', 'terminal', 'reload', 'return', 'folder', 'openSession', 'scm'].includes(type)) {
      await this.perform(type);
    }
  }

  private async perform(type: string) {
    if (!vscode.workspace.isTrusted || this.disposed) return;
    if (type === 'scm') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
    if (type === 'return') { await this.exclusive(() => this.returnFromTerminal()); return; }
    await this.exclusive(async () => {
      if (type === 'terminal' && this.handoff) {
        const term = this.findTerminal(this.handoff);
        if (term) term.show();
        else this.update('terminal', l('Return to chat after Pi has exited.', 'Pi 退出后即可返回对话。'));
        return;
      }
      if (this.phase === 'terminal') return;
      if (this.phase === 'running') {
        this.update(undefined, l('Wait for this turn to finish or stop it first.', '请等待这一轮结束，或先停止。'));
        return;
      }
      if (type === 'folder') {
        const previous = this.root;
        if (await this.chooseRoot(true) && this.root !== previous) await this.connect();
        return;
      }
      if (!await this.chooseRoot()) return;
      if (type === 'terminal') { await this.openTerminal(); return; }
      if (type === 'reload') { await this.reloadCommands(); return; }
      await this.sessionAction(type);
    });
  }

  private async reloadCommands() {
    if (this.dialogs.size) return false;
    if (this.client) {
      const file = this.sessionFile;
      this.update('transferring', l('Reloading Pi resources…', '正在重新加载 Pi 资源…'));
      try { await this.disconnect(); }
      catch (error) { this.update('disconnected'); throw error; }
      this.returnFile = file;
    }
    this.slash = undefined;
    if (!await this.connect()) return false;
    this.update('idle', l('Pi commands refreshed.', 'Pi 命令已刷新。'));
    return true;
  }

  private async sessionAction(type: string) {
    const alreadyConnected = !!this.client && !this.client.isClosed;
    if (!await this.connect(type !== 'new')) return false;
    if (type === 'new' && this.client && alreadyConnected) {
      const result = rec(await this.client.request('new_session', {}, 0));
      if (result.cancelled) this.update(undefined, l('Pi kept the current session.', 'Pi 保留了当前会话。'));
      else {
        this.clearSessionView();
        await this.syncMeta(this.client, true);
      }
    } else if (type === 'history') await this.pickHistory();
    else if (type === 'openSession') await this.pickSessionFile();
    return true;
  }

  private async exclusive(work: () => Promise<void>) {
    if (this.handling || this.disposed) return false;
    this.handling = true;
    try { await work(); return true; }
    finally { this.handling = false; this.refreshView(); }
  }

  private async chooseRoot(force = false): Promise<Root | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      this.update(undefined, l('Open a workspace folder to use Pi.', '打开一个工作区目录后即可使用 Pi。'));
      return;
    }
    if (!force && this.root && folders.some(f => f.uri.toString() === this.root?.key)) return this.root;
    const fixed = !force ? folders.find(f => f.uri.toString() === this.handoff?.rootKey) ??
      folders.find(f => f.uri.toString() === this.recentFolderKey) : undefined;
    let folder = fixed ?? (folders.length === 1 ? folders[0] : undefined);
    if (!folder) {
      const picked = await vscode.window.showQuickPick(folders.map(item => ({
        label: item.name, description: item.uri.fsPath, item,
      })), { title: l('Choose where Pi will work', '选择 Pi 的工作目录') });
      folder = picked?.item;
    }
    if (!folder) return;
    const key = folder.uri.toString();
    if (this.root?.key === key) return this.root;
    const cwd = await realpath(folder.uri.fsPath);
    if (this.client) await this.disconnect();
    if (this.root) this.returnFile = undefined;
    this.root = { folder, cwd, key };
    this.recentFolderKey = key;
    await this.ctx.workspaceState.update(ROOT, key);
    this.context = [];
    this.clearSessionView();
    this.version = undefined;
    this.models = [];
    this.slash = undefined;
    this.levels = [];
    this.model = undefined;
    this.thinking = undefined;
    this.update(this.handoff ? 'terminal' : 'disconnected');
    return this.root;
  }

  async foldersChanged() {
    if (this.root && !(vscode.workspace.workspaceFolders ?? []).some(f => f.uri.toString() === this.root?.key)) {
      // Keep a live Pi tied to its original root. Do not reroute a turn.
      this.update(undefined, l('The active Pi folder was removed from this workspace.', '当前 Pi 目录已从工作区移除。'));
    } else this.refreshView();
  }

  private async launcher() {
    if (!this.root) throw new LaunchError('missing');
    const cfg = this.configuration();
    const invocation = await resolveInvocation(this.root.cwd, cfg.get('executablePath', ''), cfg.get('nodeDirectory', ''));
    this.version = await probeVersion(invocation);
    return invocation;
  }

  private async connect(restore = true, chosen?: string): Promise<boolean> {
    if (this.client && !this.client.isClosed) return true;
    if (!this.root || this.handoff || !vscode.workspace.isTrusted || this.disposed) return false;
    if (!(vscode.workspace.workspaceFolders ?? []).some(f => f.uri.toString() === this.root?.key)) return false;
    const root = this.root;
    this.update('connecting');
    try {
      const invocation = await this.launcher();
      const candidate = chosen ?? (restore ? this.returnFile ?? this.recent(root)[0]?.file : undefined);
      const resume = candidate ? await readSession(candidate, root.cwd) : undefined;
      if (chosen && !resume) {
        this.update('disconnected', l('This Pi session does not belong to the selected folder.', '此 Pi 会话不属于选中的工作目录。'));
        return false;
      }
      this.invocation = invocation;
      let client: PiRpc;
      client = new PiRpc(invocation, resume?.file, event => { if (this.client === client) this.onEvent(event); },
        error => { if (this.client === client) this.exited(error); });
      this.client = client;
      await this.syncMeta(client, true, true);
      this.returnFile = undefined;
      this.update('idle', this.model ? undefined :
        l('No model is available. Open the Pi terminal to sign in, then return to chat.', '当前没有可用模型。可打开 Pi 终端登录，再返回对话。'));
      return true;
    } catch (error) {
      await this.disconnect();
      this.update('disconnected');
      this.report(error);
      return false;
    }
  }

  private async syncMeta(client: PiRpc, choices = false, transcript = false) {
    const tasks = [client.request('get_state')];
    if (choices) tasks.push(client.request('get_available_models'), client.request('get_available_thinking_levels'),
      client.request('get_commands'));
    if (transcript) tasks.push(client.request('get_messages'));
    const data = await Promise.all(tasks);
    if (this.client !== client) return;
    const state = rec(data[0]);
    this.sessionFile = str(state.sessionFile) || undefined;
    this.sessionId = str(state.sessionId) || undefined;
    this.session = bounded(state.sessionName, 160) || undefined;
    this.model = modelChoice(state.model);
    this.thinking = bounded(state.thinkingLevel, 30) || undefined;
    if (choices) {
      this.models = arr(rec(data[1]).models).flatMap(m => {
        const choice = modelChoice(m); return choice ? [choice] : [];
      }).slice(0, 500);
      this.levels = arr(rec(data[2]).levels).map(str).filter(Boolean).slice(0, 16);
      this.slash = slashChoices(data[3]);
    }
    if (transcript) this.rows = new Map(historyRows(rec(data.at(-1)).messages).map(row => [row.id, row]));
    await this.remember();
    this.refreshView();
  }

  private clearSessionView() {
    this.rows.clear();
    this.assistant = undefined;
    this.session = this.sessionId = this.sessionFile = this.extensionTitle = undefined;
    this.status.clear();
    this.clearDialogs();
  }

  private recentKey(root: Root) { return 'piWorkspace.history:' + root.key; }
  private recent(root: Root) { return this.ctx.workspaceState.get<Session[]>(this.recentKey(root), []); }
  private async remember() {
    const root = this.root, file = this.sessionFile, name = this.session;
    if (!root || !file) return;
    const saved = await readSession(file, root.cwd);
    if (saved) {
      const prev = this.recent(root);
      await this.ctx.workspaceState.update(this.recentKey(root), [{ ...saved, name }, ...prev.filter(x => x.file !== saved.file)].slice(0, 100));
    }
  }

  private async pickHistory() {
    if (!this.root || !this.client) return;
    const sessions = await listSessions(this.sessionFile, this.root.cwd, this.recent(this.root));
    const chooseFile = l('Open another Pi session file…', '打开其他 Pi 会话文件…');
    const picked = await vscode.window.showQuickPick<{ label: string; description?: string; file?: string }>([
      ...sessions.map(s => ({ label: s.name || new Date(s.updated).toLocaleString(),
        description: s.id.slice(0, 12), file: s.file })),
      { label: chooseFile },
    ], { title: l('Pi conversations in this workspace folder', '此工作目录中的 Pi 会话') });
    if (!picked) return;
    if (picked.file) await this.switchSession(picked.file);
    else await this.pickSessionFile();
  }

  private async pickSessionFile() {
    if (!this.root || !this.client) return;
    const uri = this.sessionFile ? this.hostUri(this.sessionFile) : this.root.folder.uri;
    const files = await vscode.window.showOpenDialog({ defaultUri: uri, canSelectMany: false,
      filters: { 'Pi JSONL': ['jsonl'] }, openLabel: l('Open Pi Session', '打开 Pi 会话') });
    if (files?.[0]) await this.switchSession(files[0].fsPath);
  }

  private async switchSession(file: string) {
    const client = this.client, root = this.root;
    if (!client || !root || this.phase !== 'idle') return;
    const session = await readSession(file, root.cwd);
    if (!session) { this.update(undefined, l('The selected file is not a Pi session for this folder.', '所选文件不是当前工作目录的 Pi 会话。')); return; }
    if (session.id === this.sessionId) return;
    const data = rec(await client.request('switch_session', { sessionPath: session.file }, 0));
    if (data.cancelled) { this.update(undefined, l('Pi kept the current session.', 'Pi 保留了当前会话。')); return; }
    this.clearSessionView();
    await this.syncMeta(client, true, true);
    this.update('idle');
  }

  private async prompt(id: string, text: string, forceTerminal = false) {
    if (!id || id.length > 80 || !text.trim() || text.length > 120000) {
      this.post({ type: 'sendResult', id, outcome: 'rejected' }); return;
    }
    let outcome: 'rejected' | 'unknown' | 'accepted' = 'rejected';
    try {
      await this.exclusive(async () => {
        if (this.phase === 'terminal' || this.phase === 'running' || this.dialogs.size) return;
        const command = text.trim().match(/^\/([^\s/]+)(?=\s|$)/)?.[1];
        if (forceTerminal && !command) return;
        const terminalAlias = command === 'terminal' && !this.slash?.some(item => item.name === command);
        if (command && (forceTerminal || BUILT_IN_NAMES.has(command) || terminalAlias)) {
          const inTerminal = forceTerminal || !PANEL_COMMANDS.has(command);
          if (!inTerminal && text.trim() !== '/' + command) {
            this.update(undefined, l('This sidebar command takes no arguments.', '此侧栏命令不接受参数。'));
            return;
          }
          if (!inTerminal && command === 'quit') {
            if (this.client) {
              const file = this.sessionFile;
              this.update('transferring', l('Stopping Pi…', '正在停止 Pi…'));
              try { await this.disconnect(); }
              catch (error) { this.update('disconnected'); throw error; }
              this.returnFile = file;
            }
            this.update('disconnected', l('Pi stopped. Start Pi to continue the saved conversation.',
              'Pi 已停止。启动 Pi 可继续已保存的会话。'));
          } else {
            if (!await this.chooseRoot()) return;
            if (inTerminal) {
              if (!await this.openTerminal(terminalAlias ? undefined : command)) return;
            } else if (command === 'reload') {
              if (!await this.reloadCommands()) return;
            } else if (!await this.sessionAction(command === 'new' ? 'new' : 'history')) return;
          }
          outcome = 'accepted';
          return;
        }
        if (!await this.chooseRoot() || !await this.connect()) return;
        if (!this.root || !this.client) return;
        const client = this.client;
        if (!(vscode.workspace.workspaceFolders ?? []).some(f => f.uri.toString() === this.root?.key)) return;
        if (!this.model && !text.trimStart().startsWith('/')) {
          this.update(undefined, l('Open the Pi terminal to sign in or select a model first.', '请先打开 Pi 终端登录或选择模型。'));
          return;
        }
        if (command && !this.slash?.some(item => item.name === command)) {
          this.update(undefined, l('This command is not listed by Pi RPC. Open the Pi terminal to check the commands there.',
            'Pi RPC 未列出此命令。请打开 Pi 终端，查看终端支持的命令。'));
          return;
        }
        const attached = [...this.context];
        if (attached.length && text.trimStart().startsWith('/')) {
          this.update(undefined, l('Remove file context before running a slash command.', '执行斜杠命令前请移除文件引用。'));
          return;
        }
        const message = attached.length ? text + '\n\n--- Editor context (explicitly attached) ---\n' +
          attached.map(item => item.value).join('\n\n') : text;
        const token = { ended: false, acknowledged: false };
        this.acceptedPrompt = token;
        this.update('running');
        outcome = 'unknown';
        const data = rec(await client.request('prompt', { message }, 0));
        outcome = 'accepted';
        token.acknowledged = true;
        const sent = new Set(attached.map(c => c.id));
        this.context = this.context.filter(c => !sent.has(c.id));
        if (data.disposition === 'handled' && this.client === client) {
          this.acceptedPrompt = undefined;
          await this.syncMeta(client, true, true);
          this.update('idle', l('Pi handled the command.', 'Pi 已处理该命令。'));
        } else if (token.ended) {
          this.acceptedPrompt = undefined;
          void this.syncMeta(client).catch(() => {});
        }
      });
    } catch (error) {
      if (error instanceof RpcError && error.kind === 'rejected' && error.command === 'prompt') outcome = 'rejected';
      this.acceptedPrompt = undefined;
      if (this.phase === 'running' && this.client) this.update('idle');
      this.report(error);
    } finally {
      this.post({ type: 'sendResult', id, outcome });
      this.refreshView();
    }
  }

  private put(row: Row) {
    this.rows.set(row.id, row);
    while (this.rows.size > 180) {
      const first = this.rows.keys().next().value;
      if (first === undefined) break;
      this.rows.delete(first);
    }
    this.refreshView();
  }

  private onEvent(event: RecordValue) {
    switch (event.type) {
      case 'message_start': {
        const m = rec(event.message);
        if (m.role === 'assistant') this.assistant = 'a:' + randomUUID();
        break;
      }
      case 'message_update': {
        const delta = rec(event.assistantMessageEvent);
        if (delta.type !== 'text_delta' && delta.type !== 'thinking_delta') break;
        const id = this.assistant ??= 'a:' + randomUUID();
        const row = this.rows.get(id) ?? { id, kind: 'assistant' as const, text: '' };
        if (delta.type === 'text_delta') this.put({ ...row, text: bounded(row.text + str(delta.delta)) });
        else this.put({ ...row, thinking: bounded((row.thinking ?? '') + str(delta.delta)) });
        break;
      }
      case 'message_end': {
        const msg = rec(event.message);
        const id = msg.role === 'assistant' ? this.assistant ?? 'a:' + randomUUID() : 'm:' + randomUUID();
        const row = messageRow(id, msg);
        if (row) {
          const hint = row.messageError ? this.modelFailureText(msg.errorMessage) : undefined;
          this.put(hint ? { ...row, text: [row.text, hint].filter(Boolean).join('\n\n') } : row);
        }
        if (msg.role === 'assistant') this.assistant = undefined;
        break;
      }
      case 'tool_execution_start': {
        const id = str(event.toolCallId);
        if (id) this.put(toolCall('t:' + id, str(event.toolName), event.args));
        break;
      }
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const id = 't:' + str(event.toolCallId);
        const row = this.rows.get(id) ?? toolCall(id, str(event.toolName), event.args);
        if (event.type === 'tool_execution_update') this.put(toolOutput(row, event.partialResult, 'running'));
        else this.put(toolOutput(row, event.result, event.isError ? 'error' : 'done'));
        break;
      }
      case 'agent_start':
        if (this.phase !== 'connecting' && this.phase !== 'transferring') this.update('running');
        break;
      case 'agent_settled':
        if (this.acceptedPrompt) this.acceptedPrompt.ended = true;
        if (this.acceptedPrompt?.acknowledged) this.acceptedPrompt = undefined;
        if (this.phase === 'running') this.update('idle', event.aborted ? l('Turn stopped.', '本轮已停止。') : undefined);
        if (this.client && !this.acceptedPrompt) void this.syncMeta(this.client).catch(() => {});
        break;
      case 'session_info_changed':
        this.session = bounded(event.name, 160) || undefined; this.refreshView();
        void this.remember().catch(() => {}); break;
      case 'thinking_level_changed':
        this.thinking = bounded(event.level, 30) || undefined; this.refreshView(); break;
      case 'extension_ui_request': this.extensionRequest(event); break;
    }
  }

  private modelFailureText(value: unknown) {
    switch (modelFailure(value)) {
      case 'region': return l('The model provider rejected the request because of regional availability.', '模型提供方因地区可用性拒绝了请求。');
      case 'quota': return l('The model provider reported a rate or usage limit.', '模型提供方报告了速率或用量限制。');
      case 'auth': return l('The model provider reported an authentication error. Check sign-in in the Pi terminal.', '模型提供方报告了认证错误，请在 Pi 终端检查登录。');
      case 'network': return l('Pi could not connect to the model provider from this host.', '此机器上的 Pi 无法连接到模型提供方。');
      default: return l('Pi reported a model error. Check the selected model in the Pi terminal.', 'Pi 报告了模型错误，请在 Pi 终端检查所选模型。');
    }
  }

  private extensionRequest(event: RecordValue) {
    const id = str(event.id), method = str(event.method);
    if (!id || !method) return;
    if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
      if (!this.view) { this.client?.respond(id, { cancelled: true }); return; }
      if (!this.view.visible) void vscode.commands.executeCommand(VIEW + '.focus');
      const dialog: Dialog = { id, method, title: bounded(event.title, 500), message: bounded(event.message, 4000),
        options: arr(event.options).filter((x): x is string => typeof x === 'string').slice(0, 100),
        placeholder: bounded(event.placeholder, 200), prefill: bounded(event.prefill, 120000) };
      const timeout = typeof event.timeout === 'number' && event.timeout > 0 && event.timeout < 2 ** 31 - 1
        ? setTimeout(() => { this.dialogs.delete(id); this.refreshView(); }, event.timeout) : undefined;
      this.dialogs.set(id, { dialog, timer: timeout });
    } else if (method === 'notify') {
      const message = bounded(event.message, 1000);
      if (event.notifyType === 'error') void vscode.window.showErrorMessage(message);
      else if (event.notifyType === 'warning') void vscode.window.showWarningMessage(message);
      else void vscode.window.showInformationMessage(message);
    } else if (method === 'setStatus' || method === 'setWidget') {
      const key = method + ':' + str(event.statusKey || event.widgetKey);
      const text = bounded(event.statusText || arr(event.widgetLines).map(str).join('\n'), 2000);
      if (text && (this.status.size < 16 || this.status.has(key))) this.status.set(key, text);
      else this.status.delete(key);
    } else if (method === 'setTitle') this.extensionTitle = bounded(event.title, 200) || undefined;
    else if (method === 'set_editor_text') this.post({ type: 'draft', text: bounded(event.text, 120000) });
    this.refreshView();
  }

  private receiveDialog(m: RecordValue) {
    const id = str(m.id), entry = this.dialogs.get(id);
    if (!entry) return;
    if (m.cancelled === true) this.answer(id, { cancelled: true });
    else if (entry.dialog.method === 'confirm' && typeof m.confirmed === 'boolean') this.answer(id, { confirmed: m.confirmed });
    else if (typeof m.value === 'string' && m.value.length <= 120000 &&
      (entry.dialog.method !== 'select' || entry.dialog.options?.includes(m.value))) {
      this.answer(id, { value: m.value });
    }
  }

  private answer(id: string, fields: RecordValue) {
    const entry = this.dialogs.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.dialogs.delete(id);
    this.client?.respond(id, fields);
    this.refreshView();
  }

  private clearDialogs() {
    for (const entry of this.dialogs.values()) clearTimeout(entry.timer);
    this.dialogs.clear();
  }

  private async disconnect() {
    const client = this.client;
    if (!client) return;
    for (const id of this.dialogs.keys()) this.answer(id, { cancelled: true });
    await client.stop();
    if (this.client === client) this.client = undefined;
  }

  private exited(error: RpcError) {
    this.client = undefined;
    this.acceptedPrompt = undefined;
    this.clearDialogs();
    for (const row of this.rows.values()) {
      if (row.phase === 'running') this.put({ ...row, phase: 'error' });
    }
    this.update('disconnected');
    this.report(error);
  }

  private async openTerminal(command?: string) {
    const root = this.root;
    if (!root || this.handoff || this.phase === 'running' || this.dialogs.size) return;
    const invocation = this.invocation && this.client ? this.invocation : await this.launcher();
    const session = this.sessionFile ? await readSession(this.sessionFile, root.cwd) : undefined;
    const handoff: Handoff = { name: 'Pi · ' + root.folder.name + ' · ' + randomUUID().slice(0, 8), rootKey: root.key, file: session?.file };
    this.update('transferring');
    try { await this.disconnect(); } catch (error) { this.update('disconnected'); throw error; }
    if (this.disposed) return;
    this.handoff = handoff;
    try {
      await this.ctx.workspaceState.update(HANDOFF, handoff);
      const terminal = vscode.window.createTerminal({
        name: handoff.name, cwd: root.folder.uri, shellPath: invocation.command,
        shellArgs: session ? ['--session', session.file] : [],
        env: { PATH: invocation.env.PATH ?? null, PI_SESSION_ID: null, PI_SESSION_FILE: null,
          PI_CODING_AGENT_DIR: invocation.env.PI_CODING_AGENT_DIR ?? null,
          PI_CODING_AGENT_SESSION_DIR: invocation.env.PI_CODING_AGENT_SESSION_DIR ?? null,
          PI_PACKAGE_DIR: invocation.env.PI_PACKAGE_DIR ?? null },
        isTransient: false,
      });
      this.terminal = terminal;
      void Promise.resolve(terminal.processId).then(pid => {
        if (this.handoff === handoff && typeof pid === 'number') {
          this.handoff.pid = pid;
          return this.ctx.workspaceState.update(HANDOFF, this.handoff);
        }
      }).catch(() => {});
      terminal.show();
      this.update('terminal', command
        ? l(`Run /${command} in the Pi terminal. When finished, run /quit there, then start Pi here.`,
          `请在 Pi 终端执行 /${command}。完成后在终端执行 /quit，再从侧栏启动 Pi。`)
        : l('This conversation is in the Pi terminal.', '会话已移交到 Pi 终端。'));
      return true;
    } catch (e) {
      this.handoff = undefined;
      await this.ctx.workspaceState.update(HANDOFF, undefined);
      this.update('disconnected');
      throw e;
    }
  }

  private findTerminal(handoff: Handoff) {
    return this.terminal ?? vscode.window.terminals.find(term => term.name === handoff.name ||
      ('name' in term.creationOptions && term.creationOptions.name === handoff.name));
  }

  async terminalClosed(terminal: vscode.Terminal) {
    const handoff = this.handoff;
    if (!handoff || this.findTerminal(handoff) !== terminal &&
      terminal.name !== handoff.name && (!('name' in terminal.creationOptions) || terminal.creationOptions.name !== handoff.name)) return;
    this.terminal = undefined;
    if (typeof terminal.exitStatus?.code === 'number') {
      await this.finishHandoff(handoff);
      return;
    }
    // Closing a terminal tab and exiting its process are distinct events.
    for (let i = 0; i < 16 && this.handoff === handoff; i++) {
      if (this.terminalPidGone(handoff)) { await this.finishHandoff(handoff); return; }
      await wait(125);
    }
    if (this.handoff === handoff) this.update('terminal', l('Check that Pi has exited before returning to chat.', '请确认 Pi 已退出，再返回侧栏。'));
  }

  private terminalPidGone(handoff: Handoff) {
    if (typeof handoff.pid !== 'number' || !Number.isSafeInteger(handoff.pid) || handoff.pid < 1) return false;
    try { process.kill(handoff.pid, 0); return false; }
    catch (e) { return object(e).code === 'ESRCH'; }
  }

  private async finishHandoff(handoff: Handoff) {
    if (this.handoff !== handoff) return;
    this.terminal = undefined;
    this.handoff = undefined;
    this.returnFile = handoff.file;
    await this.ctx.workspaceState.update(HANDOFF, undefined);
    this.update('disconnected', l('The Pi terminal has exited. Start Pi to reopen the conversation.', 'Pi 终端已退出。启动 Pi 可重新打开会话。'));
  }
  private returnFile?: string;

  private async returnFromTerminal() {
    const handoff = this.handoff;
    if (handoff) {
      const terminal = this.findTerminal(handoff);
      if (terminal && terminal.exitStatus === undefined) {
        terminal.show();
        this.update('terminal', l('Exit Pi in the terminal before returning to chat.', '请先在终端退出 Pi，再返回侧栏。'));
        return;
      }
      if (typeof terminal?.exitStatus?.code !== 'number' && !this.terminalPidGone(handoff)) {
        if (typeof handoff.pid === 'number' && Number.isSafeInteger(handoff.pid) && handoff.pid > 0) {
          this.update('terminal', l('The previous Pi terminal process is still present or could not be verified.', '此前的 Pi 终端进程仍存在，或无法核实。'));
          return;
        } else {
          const confirm = l('Pi has exited', 'Pi 已退出');
          if (await vscode.window.showWarningMessage(
            l('The previous terminal cannot be verified. Only resume after its Pi has exited.', '无法核实此前的终端。请在其中的 Pi 已退出后再接续。'),
            { modal: true }, confirm) !== confirm) return;
        }
      }
      await this.finishHandoff(handoff);
    }
    if (await this.chooseRoot()) {
      const file = this.returnFile;
      if (await this.connect(true, file)) this.returnFile = undefined;
    }
  }

  async attachEditor(editor: vscode.TextEditor | undefined) {
    if (!vscode.workspace.isTrusted || this.handoff || !editor) return;
    const doc = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder || !['file', 'vscode-remote'].includes(doc.uri.scheme)) return;
    const candidate = editor.selection.isEmpty ? undefined : editor.selection;
    const text = candidate ? doc.getText(candidate) : '';
    const file = relative(folder.uri.fsPath, doc.uri.fsPath);
    const lines = candidate ? ':' + (candidate.start.line + 1) + '-' +
      (candidate.end.line + (candidate.end.character === 0 && candidate.end.line > candidate.start.line ? 0 : 1)) : '';
    const label = file + lines;
    const truncated = bounded(text, 24000);
    if (this.handling || this.phase === 'running') return;
    if (!this.root && !this.recentFolderKey) this.recentFolderKey = folder.uri.toString();
    await vscode.commands.executeCommand(VIEW + '.focus');
    await this.exclusive(async () => {
      const root = await this.chooseRoot();
      if (!root || root.key !== folder.uri.toString()) {
        this.update(undefined, l('Select this file’s workspace folder before attaching it.', '请先选中该文件所属的工作区目录。'));
        return;
      }
      if (this.context.length >= 8) {
        this.update(undefined, l('Remove an attachment before adding more.', '请先移除一个引用再继续添加。')); return;
      }
      this.context.push({ id: randomUUID(), label, preview: candidate ? truncated : undefined,
        value: candidate ? 'Selection from ' + label + ':\n' + truncated : 'Workspace file: ' + label });
      this.refreshView();
    });
  }

  private hostUri(file: string) {
    const base = vscode.Uri.file(file), folder = this.root?.folder.uri;
    return folder?.scheme === 'vscode-remote' ? folder.with({ path: base.path, query: '', fragment: '' }) : base;
  }

  private async openRow(type: string, id: string) {
    const row = this.rows.get(id);
    if (!row || !this.root) return;
    if (type === 'openPatch') {
      if (!row.patch) return;
      const title = (row.file ? basename(row.file) : 'Pi') + '.diff';
      const uri = vscode.Uri.from({ scheme: PATCH_SCHEME, path: '/' + title, query: randomUUID() });
      if (this.patches.size >= 24) this.patches.delete(this.patches.keys().next().value!);
      this.patches.set(uri.toString(), row.patch);
      const doc = await vscode.workspace.openTextDocument(uri);
      const diff = await vscode.languages.setTextDocumentLanguage(doc, 'diff');
      await vscode.window.showTextDocument(diff, { preview: true });
    } else if (row.file) {
      const root = this.root;
      try {
        const file = await realpath(isAbsolute(row.file) ? row.file : resolve(root.cwd, row.file));
        if (!inside(root.cwd, file)) return;
        const doc = await vscode.workspace.openTextDocument(this.hostUri(file));
        const pos = new vscode.Position(Math.max(0, Math.min(doc.lineCount - 1, (row.line ?? 1) - 1)), 0);
        await vscode.window.showTextDocument(doc, { preview: true, selection: new vscode.Range(pos, pos) });
      } catch { this.update(undefined, l('That workspace file is no longer available.', '该工作区文件当前不可用。')); }
    }
  }
  patchContent(key: string) { return this.patches.get(key) ?? ''; }

  dispose() {
    this.disposed = true;
    clearTimeout(this.renderTimer);
    this.viewSubs.forEach(d => d.dispose());
    this.clearDialogs();
    void this.client?.stop().catch(() => {});
  }
}
