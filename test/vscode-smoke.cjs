const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');

async function trace() {
  try { return (await fs.readFile(process.env.PI_SMOKE_TRACE, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

async function waitFor(predicate, description) {
  for (let i = 0; i < 100; i++) {
    const rows = await trace();
    if (predicate(rows)) return rows;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Missing VS Code smoke event: ' + description);
}

exports.run = async function () {
  assert.equal(vscode.env.remoteName, undefined);
  const ext = vscode.extensions.getExtension('ipromise.pi-workspace-chat');
  assert(ext);
  const config = vscode.workspace.getConfiguration('piWorkspace');
  await config.update('executablePath', process.env.PI_SMOKE_EXECUTABLE, vscode.ConfigurationTarget.Global);
  await config.update('nodeDirectory', process.env.PI_SMOKE_NODE, vscode.ConfigurationTarget.Global);
  await ext.activate();
  await vscode.commands.executeCommand('piWorkspace.newSession');
  await waitFor(rows => rows.some(r => r.phase === 'rpc-start'), 'start Pi in selected workspace');
  await vscode.commands.executeCommand('piWorkspace.newSession');
  const rows = await waitFor(rows => rows.some(r => r.phase === 'new-session'), 'new session');
  const session = rows.find(r => r.phase === 'new-session');
  assert.equal(session.cwd, await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath));
  await vscode.commands.executeCommand('piWorkspace.terminal');
  const moved = await waitFor(rows => rows.some(r => r.phase === 'terminal-start'), 'launch native Pi terminal');
  const end = moved.findIndex(r => r.phase === 'rpc-end');
  const start = moved.findIndex(r => r.phase === 'terminal-start');
  assert(end >= 0 && start > end);
  assert.equal(await fs.realpath(moved[start].file), await fs.realpath(session.file));
  const terminal = vscode.window.terminals.find(t => t.name.startsWith('Pi · '));
  assert(terminal, 'Expected a real VS Code terminal');
  const closed = new Promise(resolve => {
    const sub = vscode.window.onDidCloseTerminal(t => { if (t === terminal) { sub.dispose(); resolve(); } });
  });
  const pid = await terminal.processId;
  assert(pid);
  terminal.dispose();
  await closed;
  for (let i = 0; i < 40; i++) {
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (!alive) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  await vscode.commands.executeCommand('piWorkspace.start');
  const reopened = await waitFor(rows => rows.filter(r => r.phase === 'rpc-start').length === 2, 'resume after terminal exit');
  assert.equal(await fs.realpath(reopened.filter(r => r.phase === 'rpc-start').at(-1).file), await fs.realpath(session.file));
  console.log('PASS: local VS Code extension host, RPC cwd, native terminal and same-file handoff');
};
