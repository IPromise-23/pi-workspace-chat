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
    if (await predicate(rows)) return rows;
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
  await verifySending();
};

async function verifySending() {
  await vscode.commands.executeCommand('piWorkspace.focus');
  const [port] = (await fs.readFile(process.env.PI_SMOKE_DEBUG_PORT, 'utf8')).split('\n');
  let target;
  await waitFor(async () => {
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = targets.find(t => t.type === 'iframe' && t.url.includes('extensionId=ipromise.pi-workspace-chat'));
    return target;
  }, 'Pi sidebar frame');

  // Drive the rendered controls in the isolated VS Code instance.
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    function evaluate(expression) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        socket.addEventListener('message', function receive(event) {
          const reply = JSON.parse(event.data);
          if (reply.id !== requestId) return;
          socket.removeEventListener('message', receive);
          if (reply.error || reply.result.exceptionDetails) {
            reject(new Error(reply.error?.message ?? reply.result.exceptionDetails.exception?.description));
          } else resolve(reply.result.result.value);
        });
        socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: {
          expression: `(() => {
            const doc = document.querySelector('iframe#active-frame')?.contentDocument;
            return doc ? (${expression}) : null;
          })()`, returnByValue: true,
        } }));
      });
    }

    const ready = () => evaluate("!!doc.querySelector('.model:enabled option[value=\"0\"]')");
    const draft = () => evaluate("doc.querySelector('textarea.prompt').value");
    async function sendPrompt(text) {
      assert(await evaluate(`(() => {
        const input = doc.querySelector('textarea.prompt');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const send = doc.querySelector('button[aria-label="Send"], button[aria-label="发送"]');
        if (send.disabled || send.hidden) return false;
        send.click();
        return true;
      })()`), 'Prompt can be sent from the sidebar');
    }
    const notice = () => evaluate("doc.querySelector('.notice:not([hidden])')?.textContent");
    await waitFor(ready, 'sidebar ready');
    await sendPrompt('exit');
    await waitFor(() => evaluate("!!doc.querySelector('.empty button.primary:not([hidden])')"), 'Pi disconnects after send');
    assert.match(await notice(), /Send outcome unknown|发送结果未知/);
    assert.match(await notice(), /saved session.*file changes.*deciding whether to retry|已保存的会话.*文件差异.*决定是否重试/);
    assert.equal(await draft(), '');
    const workbench = vscode.workspace.getConfiguration('workbench');
    for (const [theme, kind] of [['Light Modern', 'light'], ['Dark Modern', 'dark']]) {
      await workbench.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      await waitFor(() => evaluate(`(() => {
        const feedback = doc.querySelector('.notice[role="status"]:not([hidden])');
        return doc.body.classList.contains('vscode-${kind}') && feedback?.getBoundingClientRect().height > 0;
      })()`), 'unknown send notice is visible in ' + theme);
    }
    console.log('PASS: sidebar reports unknown send outcome after Pi exits before acknowledgement');

    await sendPrompt('reject prompt');
    await waitFor(async () => await draft() === 'reject prompt', 'Pi rejection restores the draft');
    await waitFor(ready, 'sidebar ready after rejection');
    assert(await evaluate("!doc.querySelector('textarea.prompt').disabled && !doc.querySelector('textarea.prompt').readOnly"));
    assert.doesNotMatch(await notice() ?? '', /Send outcome unknown|发送结果未知/);
    console.log('PASS: sidebar retains an editable draft after Pi explicitly rejects the prompt');

    await sendPrompt('hold');
    const stopSelector = 'button[aria-label="Stop"], button[aria-label="停止"]';
    await waitFor(() => evaluate(`!doc.querySelector(${JSON.stringify(stopSelector)}).hidden`), 'sidebar shows turn in progress');
    assert.match(await evaluate("doc.querySelector('.info').textContent"), /Pi is working|Pi 正在工作/);
    await evaluate(`doc.querySelector(${JSON.stringify(stopSelector)}).click()`);
    await waitFor(ready, 'sidebar ready after stopping fixture turn');

    await sendPrompt('hello from the sidebar');
    await waitFor(async () => {
      const timeline = await evaluate("doc.querySelector('.timeline').textContent");
      return timeline?.includes('hello from the sidebar') && timeline.includes('Hello Pi 🙂 separator');
    }, 'sidebar shows prompt and assistant reply');
    assert.equal(await draft(), '');
    assert.doesNotMatch(await notice() ?? '', /Send outcome unknown|发送结果未知/);
    console.log('PASS: sidebar shows progress and conversation for acknowledged prompts');

    const traceCount = async phase => (await trace()).filter(r => r.phase === phase).length;
    const editPrompt = value => evaluate(`(() => {
      const input = doc.querySelector('textarea.prompt');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const commandNames = () => evaluate("Array.from(doc.querySelectorAll('.slash-option'), button => button.dataset.command)");
    await editPrompt('/');
    const allCommands = await commandNames();
    assert.equal(allCommands.length, 76);
    assert(allCommands.includes('before-refresh') && allCommands.includes('skill:fixture-49'));
    assert.match(await evaluate("doc.querySelector('.slash-actions [role=status]').textContent"), /76/);
    const last = await evaluate(`(() => {
      const input = doc.querySelector('textarea.prompt');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      const list = doc.querySelector('.slash');
      return { name: list.querySelector('.active').dataset.command, scrolled: list.scrollTop > 0 };
    })()`);
    assert.deepEqual(last, { name: 'skill:fixture-49', scrolled: true });
    const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const beforeReload = (await trace()).filter(r => r.phase === 'rpc-start').at(-1).file;
    await fs.writeFile(workspace + '/reload-marker', '');
    await evaluate("doc.querySelector('.slash-actions button').click()");
    await waitFor(async () => (await commandNames()).includes('after-refresh'), 'newly loaded resource is in the menu');
    assert(!(await commandNames()).includes('before-refresh'));
    assert.equal((await trace()).filter(r => r.phase === 'rpc-start').at(-1).file, beforeReload);
    console.log('PASS: all 76 slash commands are browsable and refresh replaces resources without switching sessions');
    const startCount = await traceCount('rpc-start');
    assert(await evaluate(`(() => {
      const input = doc.querySelector('textarea.prompt');
      input.value = '/quit';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const suggested = doc.querySelector('.slash:not([hidden]) button');
      if (!suggested?.textContent.startsWith('/quit')) return false;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`), 'Exact command can be submitted with Enter');
    await waitFor(async () => /Pi stopped|Pi 已停止/.test(await notice()), 'sidebar reports orderly quit');
    assert.match(await evaluate("doc.querySelector('.timeline').textContent"), /hello from the sidebar/);
    assert.equal(await traceCount('rpc-start'), startCount);
    await vscode.commands.executeCommand('piWorkspace.start');
    await waitFor(ready, 'start after quit');
    assert.equal((await trace()).filter(r => r.phase === 'rpc-start').at(-1).file,
      (await trace()).filter(r => r.phase === 'rpc-end').at(-1).file);

    const newCount = await traceCount('new-session');
    await sendPrompt('/new');
    await waitFor(async () => await traceCount('new-session') === newCount + 1 && await ready(), 'sidebar new session');
    for (const command of ['/login', '/tree', '/fixture']) {
      const previous = await traceCount('terminal-start');
      if (command === '/fixture') {
        await editPrompt(command);
        await evaluate("doc.querySelector('.slash-actions button:last-child').click()");
      } else await sendPrompt(command);
      const events = await waitFor(rows => rows.filter(r => r.phase === 'terminal-start').length === previous + 1,
        command + ' opens native terminal');
      const moved = events.at(-1);
      assert.equal(moved.phase, 'terminal-start');
      assert.equal(events.at(-2).phase, 'rpc-end');
      assert.equal(await fs.realpath(moved.file), await fs.realpath(events.at(-2).file));
      await waitFor(async () => (await notice())?.includes(command), command + ' shows terminal instructions');
      assert.equal(await draft(), '');
      const terminal = vscode.window.terminals.find(t => t.name.startsWith('Pi · '));
      assert(terminal);
      terminal.dispose();
      await waitFor(async () => /terminal has exited|终端已退出/.test(await notice()), 'terminal exits');
      await vscode.commands.executeCommand('piWorkspace.start');
      await waitFor(ready, 'sidebar resumes after ' + command);
      assert.equal((await trace()).filter(r => r.phase === 'rpc-start').at(-1).file, moved.file);
      const session = await fs.readFile(moved.file, 'utf8');
      assert(!session.includes(command), 'TUI command was not recorded as a prompt');
    }
    console.log('PASS: sidebar quit/new, login/tree and third-party terminal handoff with same-session recovery');
  } finally {
    socket.close();
  }
}
