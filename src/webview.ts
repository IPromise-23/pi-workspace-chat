import MarkdownIt from 'markdown-it';
import type { Dialog, Row, Snapshot } from './protocol';

declare const acquireVsCodeApi: () => { postMessage: (message: object) => void };
const vs = acquireVsCodeApi();
const md = new MarkdownIt({ html: false, linkify: false, breaks: true }).disable('image');
const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
const l = (en: string, cn: string) => zh ? cn : en;
const app = document.querySelector<HTMLElement>('#app')!;
const send = (type: string, fields: object = {}) => vs.postMessage({ type, ...fields });
const el = <T extends keyof HTMLElementTagNameMap>(tag: T, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};
function button(text: string, fn: () => void, style = 'subtle') {
  const b = el('button', style, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
function label(node: HTMLElement, text: string) { node.setAttribute('aria-label', text); }
function markdown(node: HTMLElement, text: string) { node.innerHTML = md.render(text); }

const icons = {
  history: 'M3 3v5h5M3.5 8a8 8 0 1 1 .5 8M12 7v5l3 2',
  settings: 'M10 3h4l.5 2.3 1.7 1 2.2-.7 2 3.5-1.7 1.6v2l1.7 1.6-2 3.5-2.2-.7-1.7 1-.5 2.3h-4l-.5-2.3-1.7-1-2.2.7-2-3.5 1.7-1.6v-2L3.6 9.1l2-3.5 2.2.7 1.7-1L10 3ZM15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
  compose: 'M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M10 14l.8-3.4L19 2.5l2.5 2.5-8.1 8.2L10 14Z',
  plus: 'M12 5v14M5 12h14',
  changes: 'M7 18V6m0 8c5 0 10-2 10-7M9 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 16a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM19 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  send: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M7 7h10v10H7Z',
};

function iconButton(name: keyof typeof icons, description: string, action: () => void, style = 'icon-button') {
  const b = button('', action, style);
  b.title = description;
  label(b, description);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', icons[name]);
  svg.append(path);
  b.append(svg);
  return b;
}

const head = el('header', 'header');
const heading = el('div', 'heading');
const chatActions = el('div', 'chat-actions');
const history = iconButton('history', l('Conversation history', '会话历史'), () => send('history'));
const configure = iconButton('settings', l('Pi settings', 'Pi 设置'), () => send('settings'));
const create = iconButton('compose', l('New conversation', '新建会话'), () => send('new'));
chatActions.append(history, configure, create);
heading.append(el('span', 'chat-title', l('Chat', '聊天')), chatActions);
const locationBar = el('div', 'location');
const host = el('strong', 'host');
const folder = button('', () => send('folder'), 'folder');
const version = el('span', 'version');
locationBar.append(host, folder, version);
const name = el('div', 'session');
const info = el('div', 'info');
info.setAttribute('role', 'status');
const sendNotice = el('div', 'notice', l(
  'Send outcome unknown. Check the saved session in Conversation History and review file changes in Source Control before deciding whether to retry.',
  '发送结果未知。请在会话历史中检查已保存的会话，并在源代码管理中查看文件差异，再决定是否重试。'));
sendNotice.hidden = true;
sendNotice.setAttribute('role', 'status');
const notice = el('div', 'notice');
notice.setAttribute('role', 'status');
const noticeText = el('span');
const settings = button(l('Open Settings', '打开设置'), () => send('settings'));
notice.append(noticeText, settings);
head.append(heading, locationBar, name, info, sendNotice, notice);

const scroll = el('section', 'scroll');
label(scroll, l('Conversation', '对话'));
const empty = el('div', 'empty');
const mark = el('div', 'empty-mark', 'π');
mark.setAttribute('aria-hidden', 'true');
const help = el('p');
const openFolder = button(l('Open Folder…', '打开文件夹…'), () => send('openFolder'));
const connect = button(l('Start Pi', '启动 Pi'), () => send('start'), 'primary');
const terminal = button(l('Open Pi Terminal', '打开 Pi 终端'), () => send('terminal'));
const returnButton = button(l('Return to Chat', '返回侧栏'), () => send('return'), 'primary');
const startActions = el('div', 'actions');
startActions.append(openFolder, connect, returnButton, terminal);
empty.append(mark, help, startActions);
const timeline = el('div', 'timeline');
const extStatus = el('div', 'extension-status');
scroll.append(empty, timeline, extStatus);

const footer = el('footer', 'footer');
const dialogs = el('section', 'dialogs');
const chips = el('div', 'chips');
const slash = el('div', 'slash');
slash.hidden = true;
label(slash, l('Pi commands', 'Pi 命令'));
const slashActions = el('div', 'slash-actions');
slashActions.hidden = true;
const slashCount = el('span', 'muted');
slashCount.setAttribute('role', 'status');
const refreshCommands = button(l('Refresh commands', '刷新命令'), () => send('reload'));
function runSelectedCommand(inTerminal: boolean) {
  const active = slash.querySelector<HTMLButtonElement>('.active');
  if (active?.dataset.command) prompt.value = '/' + active.dataset.command;
  submitPrompt(inTerminal);
}
const sidebarCommand = button(l('Run in sidebar', '在侧栏运行'), () => runSelectedCommand(false));
const terminalCommand = button(l('Run in Pi terminal', '在 Pi 终端执行'), () => runSelectedCommand(true));
slashActions.append(slashCount, refreshCommands, sidebarCommand, terminalCommand);
const prompt = el('textarea', 'prompt');
prompt.maxLength = 120000;
prompt.rows = 3;
prompt.placeholder = l('Ask Pi about your workspace…', '向 Pi 提问，或让它修改当前工作区…');
label(prompt, l('Message to Pi', '发给 Pi 的消息'));
const toolbar = el('div', 'toolbar');
const choices = el('div', 'choices');
const model = el('select', 'model');
const thinking = el('select', 'thinking');
label(model, l('Model', '模型')); label(thinking, l('Thinking level', '思考强度'));
choices.append(model, thinking);
const actions = el('div', 'actions');
const attach = iconButton('plus', l('Attach the active file or editor selection', '引用当前文件或编辑器选区'), () => send('attach'));
const scm = iconButton('changes', l('Review in VS Code Source Control', '在 VS Code 源代码管理中审阅'), () => send('scm'));
const stop = iconButton('stop', l('Stop', '停止'), () => send('stop'), 'primary round-button');
const submit = iconButton('send', l('Send', '发送'), () => submitPrompt(), 'primary round-button');
actions.append(attach, scm);
const sendActions = el('div', 'send-actions');
sendActions.append(stop, submit);
toolbar.append(actions, choices, sendActions);
const composer = el('div', 'composer');
composer.append(chips, slash, slashActions, prompt, toolbar);
footer.append(dialogs, composer);
app.append(head, scroll, footer);
app.hidden = true;

let state: Snapshot | undefined;
let nextPrompt = 0;
let pending: { id: string; text: string } | undefined;
let matchIndex = 0;
let listedOptions: Snapshot['slash'] = [];
let slashDismissed = false;
const rowViews = new Map<string, { node: HTMLElement; data: string; open?: boolean }>();
const chipViews = new Map<string, HTMLElement>();
let dialogId: string | undefined;
let modelSignature = '';
let thinkingSignature = '';
let expandedDefault: boolean | undefined;

function canSend() {
  return !!state?.hasFolder && !pending && state.phase !== 'running' && state.phase !== 'connecting'
    && state.phase !== 'transferring' && state.phase !== 'terminal' && !!prompt.value.trim();
}
function submitPrompt(inTerminal = false) {
  if (!canSend()) return;
  const id = Date.now().toString(36) + '-' + (++nextPrompt), text = prompt.value;
  pending = { id, text };
  sendNotice.hidden = true;
  prompt.value = '';
  send('prompt', { id, text, inTerminal });
  updateComposer();
}
function updateComposer() {
  submit.disabled = !canSend();
  submit.title = state?.modifierSend ? l('Command/Ctrl+Enter to send', 'Command/Ctrl+Enter 发送')
    : l('Enter to send; Shift+Enter for a new line', 'Enter 发送；Shift+Enter 换行');
  const regex = prompt.value.match(/^\/([^\s/]*)/);
  const show = !!regex && !!state?.hasFolder && !pending && !slashDismissed &&
    (state.phase === 'idle' || state.phase === 'disconnected');
  const options = show && regex?.[0] === prompt.value
    ? (state?.slash ?? []).filter(item => item.name.toLowerCase().startsWith(regex[1].toLowerCase())) : [];
  slash.hidden = options.length === 0;
  slashActions.hidden = !show;
  const count = regex?.[0] === prompt.value
    ? state?.commandsLoaded ? l(`${options.length} commands`, `${options.length} 条命令`)
      : l('Start Pi to discover commands', '启动 Pi 以读取完整命令')
    : '';
  if (slashCount.textContent !== count) slashCount.textContent = count;
  terminalCommand.hidden = !options.length && !regex?.[1];
  matchIndex = Math.max(0, Math.min(matchIndex, options.length - 1));
  const selected = options[matchIndex] ?? state?.slash.find(item => item.name === regex?.[1]);
  sidebarCommand.hidden = !selected || selected.source === 'terminal';
  if (options.length !== listedOptions.length || options.some((item, index) => {
    const previous = listedOptions[index];
    return item.name !== previous.name || item.description !== previous.description || item.source !== previous.source;
  })) {
    listedOptions = options;
    slash.replaceChildren(...options.map(item => {
      const b = button('/' + item.name, () => {
        prompt.value = '/' + item.name + ' ';
        matchIndex = 0; updateComposer(); prompt.focus();
      }, 'slash-option');
      b.dataset.command = item.name;
      if (item.description) b.append(el('span', 'muted', item.description));
      return b;
    }));
    slash.scrollTop = 0;
  }
  slash.querySelector('.active')?.classList.remove('active');
  slash.children[matchIndex]?.classList.add('active');
}

prompt.addEventListener('input', () => {
  slashDismissed = false;
  matchIndex = 0;
  if (prompt.value === '/' && state?.hasFolder && state.phase === 'disconnected' && !state.commandsLoaded) send('start');
  updateComposer();
});
prompt.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return;
  if (!slash.hidden && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    matchIndex = (matchIndex + (e.key === 'ArrowDown' ? 1 : -1) + slash.children.length) % slash.children.length;
    updateComposer();
    slash.children[matchIndex]?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const complete = slash.children[matchIndex] as HTMLButtonElement | undefined;
  const exact = !!complete && complete.firstChild?.textContent === prompt.value;
  if (!slash.hidden && (e.key === 'Tab' || !exact && e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey)) {
    e.preventDefault(); complete?.click(); return;
  }
  if (e.key === 'Escape' && !slashActions.hidden) { slashDismissed = true; updateComposer(); }
  if (e.key === 'Enter' && !e.shiftKey && (!state?.modifierSend || e.metaKey || e.ctrlKey)) {
    e.preventDefault(); submitPrompt();
  }
});
model.addEventListener('change', () => {
  const selected = state?.models[Number(model.value)];
  if (model.value !== '' && selected) send('model', { provider: selected.provider, id: selected.id });
});
thinking.addEventListener('change', () => send('thinking', { level: thinking.value }));

app.addEventListener('click', e => {
  if (!(e.target instanceof Element)) return;
  const link = e.target.closest('a[href]');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) send('link', { href });
});

function renderRow(row: Row, old?: HTMLElement) {
  if (row.kind === 'tool') {
    const detail = el('details', 'card tool ' + (row.phase === 'error' ? 'error' : ''));
    const summary = el('summary');
    const phase = row.phase === 'running' ? '…' : row.phase === 'error' ? '!' : '✓';
    summary.append(el('span', 'phase', phase), el('strong', undefined, row.tool || l('Tool', '工具')));
    if (row.summary) summary.append(el('span', 'summary-text', row.summary));
    detail.append(summary);
    detail.open = (row.phase === 'error' && old?.classList.contains('error') !== true) ||
      (old instanceof HTMLDetailsElement && expandedDefault === state?.toolExpanded
        ? old.open : !!state?.toolExpanded || row.phase === 'error');
    if (row.text) detail.append(el('pre', 'output', row.text));
    if (row.patch) {
      const patch = el('pre', 'patch');
      for (const line of row.patch.split('\n')) {
        const css = line.startsWith('+') && !line.startsWith('+++') ? 'added'
          : line.startsWith('-') && !line.startsWith('---') ? 'removed'
          : line.startsWith('@@') ? 'hunk' : '';
        patch.append(el('span', css || undefined, line + '\n'));
      }
      detail.append(patch);
    }
    const bar = el('div', 'card-actions');
    if (row.file) bar.append(button(l('Open File', '打开文件'), () => send('openFile', { id: row.id })));
    if (row.patch) bar.append(button(l('Open Patch', '打开补丁'), () => send('openPatch', { id: row.id })));
    if (bar.childElementCount) detail.append(bar);
    return detail;
  }
  const card = el('article', 'card ' + row.kind + (row.messageError ? ' error' : ''));
  card.append(el('div', 'role', row.kind === 'user' ? l('You', '你') : 'Pi'));
  if (row.thinking) {
    const details = el('details', 'thinking-detail');
    details.append(el('summary', undefined, l('Thinking', '思考')), el('pre', 'output', row.thinking));
    const previous = old?.querySelector('details');
    details.open = previous?.open ?? false;
    card.append(details);
  }
  if (row.text) {
    const body = el('div', row.kind === 'assistant' ? 'markdown' : 'user-text');
    if (row.kind === 'assistant') markdown(body, row.text);
    else body.textContent = row.text;
    card.append(body);
  }
  return card;
}

function renderTimeline(rows: Row[]) {
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 95;
  const ids = new Set(rows.map(row => row.id));
  for (const [id, item] of rowViews) {
    if (!ids.has(id)) { item.node.remove(); rowViews.delete(id); }
  }
  let cursor = timeline.firstElementChild;
  for (const row of rows) {
    const json = JSON.stringify(row);
    let item = rowViews.get(row.id);
    if (!item || item.data !== json || row.kind === 'tool' && expandedDefault !== state?.toolExpanded) {
      const node = renderRow(row, item?.node);
      if (item?.node === cursor) { item?.node.replaceWith(node); cursor = node; }
      else item?.node.remove();
      item = { node, data: json };
      rowViews.set(row.id, item);
    }
    if (cursor !== item.node) timeline.insertBefore(item.node, cursor);
    cursor = item.node.nextElementSibling;
  }
  expandedDefault = state?.toolExpanded;
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
}

function renderChips(context: Snapshot['context']) {
  const current = new Set(context.map(item => item.id));
  for (const [id, node] of chipViews) {
    if (!current.has(id)) { node.remove(); chipViews.delete(id); }
  }
  for (const item of context) {
    if (chipViews.has(item.id)) continue;
    const node = el('div', 'chip');
    const remove = button('×', () => send('detach', { id: item.id }));
    label(remove, l('Remove ', '移除 ') + item.label);
    const preview = el('details');
    preview.append(el('summary', undefined, item.label));
    preview.append(el('pre', 'output', item.preview || l('File path only; Pi can read the file using its own tools.',
      '只发送文件路径；Pi 可以使用自身工具读取文件。')));
    node.append(preview, remove);
    chips.append(node);
    chipViews.set(item.id, node);
  }
  chips.hidden = !context.length;
}

function renderDialog(d: Dialog | undefined) {
  if (dialogId === d?.id) return;
  dialogId = d?.id;
  dialogs.replaceChildren();
  if (!d) return;
  const card = el('div', 'dialog');
  card.setAttribute('role', 'group');
  label(card, d.title || l('Pi extension request', 'Pi 扩展请求'));
  card.append(el('strong', undefined, d.title || l('Pi extension request', 'Pi 扩展请求')));
  if (d.message) card.append(el('div', 'dialog-message', d.message));
  const row = el('div', 'actions');
  const reply = (fields: object) => {
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    send('dialog', { id: d.id, ...fields });
  };
  if (d.method === 'confirm') {
    row.append(button(l('Allow', '允许'), () => reply({ confirmed: true }), 'primary'),
      button(l('Decline', '拒绝'), () => reply({ confirmed: false })));
  } else if (d.method === 'select') {
    const field = el('select', 'dialog-input');
    label(field, d.title || l('Choose an option', '请选择'));
    for (const option of d.options ?? []) field.add(new Option(option, option));
    card.append(field);
    if (field.options.length) row.append(button(l('Select', '选择'), () => reply({ value: field.value }), 'primary'));
  } else {
    const field = d.method === 'editor' ? el('textarea', 'dialog-input') : el('input', 'dialog-input');
    field.value = d.prefill ?? '';
    field.placeholder = d.placeholder ?? '';
    field.maxLength = 120000;
    label(field, d.title || l('Enter a value', '输入内容'));
    card.append(field);
    row.append(button(l('Submit', '提交'), () => reply({ value: field.value }), 'primary'));
  }
  row.append(button(l('Cancel', '取消'), () => reply({ cancelled: true })));
  card.append(row);
  dialogs.append(card);
}

function render(snapshot: Snapshot) {
  state = snapshot;
  app.hidden = false;
  const phase = snapshot.phase;
  const available = snapshot.hasFolder && (phase === 'idle' || phase === 'disconnected');
  history.disabled = !available;
  create.disabled = !available;
  locationBar.hidden = !snapshot.hasFolder;
  host.textContent = snapshot.host;
  folder.textContent = snapshot.folder || l('Choose folder', '选择目录');
  folder.title = folder.textContent;
  folder.disabled = !available;
  version.textContent = snapshot.version ? 'Pi ' + snapshot.version : '';
  name.textContent = snapshot.extensionTitle || snapshot.session || '';
  name.hidden = !name.textContent;
  const phases: Record<Snapshot['phase'], string> = {
    idle: l('Ready', '就绪'), connecting: l('Connecting to Pi…', '正在连接 Pi…'),
    disconnected: l('Pi is stopped', 'Pi 尚未启动'), running: l('Pi is working…', 'Pi 正在工作…'),
    terminal: l('Using Pi in the terminal', '正在终端使用 Pi'), transferring: l('Handing off the conversation…', '正在移交会话…'),
  };
  const status = snapshot.hasFolder && phase !== 'idle' ? phases[phase] : '';
  if (info.textContent !== status) info.textContent = status;
  info.hidden = !status;
  notice.hidden = !snapshot.notice;
  noticeText.textContent = snapshot.notice ?? '';
  settings.hidden = !snapshot.settingsHint;
  empty.hidden = !!snapshot.rows.length && phase !== 'disconnected' && phase !== 'terminal';
  scroll.classList.toggle('empty-state', !snapshot.rows.length);
  mark.hidden = !!snapshot.rows.length;
  help.textContent = !snapshot.hasFolder ? l('Open a workspace to start a chat with Pi.',
    '打开工作区，开始与 Pi 聊天。')
    : phase === 'terminal' ? l('Exit Pi in the terminal before continuing this conversation here.',
      '先在终端退出 Pi，再回到这里继续会话。')
    : l('Ask a question or start a task with Pi.', '提个问题，或让 Pi 开始一项任务。');
  openFolder.hidden = snapshot.hasFolder;
  connect.hidden = !snapshot.hasFolder || phase !== 'disconnected';
  returnButton.hidden = phase !== 'terminal';
  terminal.hidden = !snapshot.hasFolder || !['idle', 'terminal', 'disconnected'].includes(phase);
  extStatus.textContent = snapshot.status.join('\n');
  extStatus.hidden = !snapshot.status.length;
  attach.disabled = !available;
  scm.disabled = !snapshot.hasFolder;
  stop.hidden = phase !== 'running';
  submit.hidden = phase === 'running';
  model.hidden = !snapshot.models.length;
  thinking.hidden = !snapshot.thinkingLevels.length;
  model.disabled = phase !== 'idle' || !snapshot.models.length;
  thinking.disabled = phase !== 'idle' || !snapshot.thinkingLevels.length;
  prompt.disabled = !snapshot.hasFolder || phase === 'terminal' || phase === 'transferring';
  prompt.placeholder = snapshot.hasFolder ? l('Ask Pi about your workspace…', '向 Pi 提问，或让它修改当前工作区…')
    : l('Open a workspace to chat…', '打开工作区后开始聊天…');
  const ms = JSON.stringify(snapshot.models);
  if (ms !== modelSignature) {
    modelSignature = ms;
    model.replaceChildren(new Option(l('Select model', '选择模型'), ''),
      ...snapshot.models.map((m, i) => new Option(m.name + ' · ' + m.provider, String(i))));
  }
  const choice = snapshot.models.findIndex(m => m.provider === snapshot.model?.provider && m.id === snapshot.model?.id);
  model.value = choice >= 0 ? String(choice) : '';
  model.title = snapshot.model ? snapshot.model.provider + '/' + snapshot.model.id : l('Pi model', 'Pi 模型');
  const ts = JSON.stringify(snapshot.thinkingLevels);
  if (ts !== thinkingSignature) {
    thinkingSignature = ts;
    thinking.replaceChildren(...snapshot.thinkingLevels.map(level => new Option(level, level)));
  }
  thinking.value = snapshot.thinking ?? '';
  renderChips(snapshot.context);
  renderDialog(snapshot.dialogs[0]);
  renderTimeline(snapshot.rows);
  updateComposer();
}

window.addEventListener('message', e => {
  const message = e.data;
  if (message?.type === 'snapshot') render(message.value as Snapshot);
  else if (message?.type === 'sendResult' && pending?.id === message.id) {
    const sent = pending;
    pending = undefined;
    if (message.outcome === 'rejected' && !prompt.value && sent) prompt.value = sent.text;
    if (message.outcome === 'unknown') sendNotice.hidden = false;
    updateComposer();
  } else if (message?.type === 'draft' && typeof message.text === 'string') {
    prompt.value = message.text; updateComposer(); prompt.focus();
  }
});
send('ready');
