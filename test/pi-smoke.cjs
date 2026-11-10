const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PiRpc } = require('../dist/test/rpc.cjs');
const { resolveInvocation, probeVersion } = require('../dist/test/launch.cjs');

async function main() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-workspace-real-')));
  const workspace = join(temp, 'workspace');
  const agent = join(temp, 'agent');
  const skill = join(agent, 'skills', 'workspace-fixture');
  await Promise.all([mkdir(workspace), mkdir(join(agent, 'extensions'), { recursive: true }), mkdir(skill, { recursive: true })]);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: workspace-fixture\ndescription: A local integration fixture.\n---\nReturn the fixture marker.\n');
  await writeFile(join(agent, 'extensions', 'workspace-fixture.ts'), `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function (pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  pi.registerProvider('local-fixture', {
    baseUrl: 'http://localhost.invalid', api: 'local-fixture-api', apiKey: 'fixture-placeholder',
    models: [{ id: 'fixture', name: 'Local test model', reasoning: false, input: ['text'], cost,
      contextWindow: 8192, maxTokens: 512 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const lastUser = context.messages.filter(m => m.role === 'user').at(-1);
      const last = context.messages.filter(m => m.role !== 'system').at(-1);
      const userText = typeof lastUser?.content === 'string' ? lastUser.content :
        lastUser?.content?.map(item => item.text ?? '').join(' ');
      const edit = userText?.includes('PI_VSCODE_BEFORE') && last?.role === 'user';
      const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
        stopReason: 'pending', timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: output });
        if (edit) {
          output.content = [{ type: 'toolCall', id: 'fixture-edit', name: 'edit',
            arguments: { path: 'target.txt', edits: [{ oldText: 'PI_VSCODE_BEFORE', newText: 'PI_VSCODE_AFTER' }] } }];
          output.stopReason = 'toolUse';
        } else {
          const text = last?.role === 'toolResult' ? 'Updated the fixture file.' : 'Hello from the **local test model**.';
          output.content = [{ type: 'text', text }];
          stream.push({ type: 'text_start', contentIndex: 0, partial: output });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output });
          output.stopReason = 'stop';
        }
        stream.push({ type: 'done', reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
  pi.registerCommand("workspace-fixture", {
    description: "Check the four RPC dialog shapes",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Approve fixture?", "This is a local test.");
      const selected = await ctx.ui.select("Select fixture", ["red", "blue"]);
      const text = await ctx.ui.input("Enter fixture", "short text");
      const edited = await ctx.ui.editor("Edit fixture", "initial");
      if (confirmed && selected === "blue" && text === "short" && edited === "line1\\nline2") {
        ctx.ui.notify("fixture-complete", "info");
      }
    },
  });
}
`);
  const inv = await resolveInvocation(workspace, process.env.PI_TEST_EXECUTABLE || '', process.env.PI_TEST_NODE_DIRECTORY || '');
  const version = await probeVersion(inv);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'local-fixture', defaultModel: 'fixture' }));
  const file = join(workspace, 'target.txt');
  await writeFile(file, 'PI_VSCODE_BEFORE\n');
  if (process.argv.includes('--prepare-ui')) {
    console.log(JSON.stringify({ workspace, agent, sessions: join(temp, 'ui-sessions') }));
    return;
  }
  const safeEnv = { ...inv.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(temp, 'isolated-sessions') };
  const methods = [];
  const events = [];
  let notified = false;
  let client;
  client = new PiRpc({ ...inv, env: safeEnv }, undefined, event => {
    events.push(event);
    if (event.type !== 'extension_ui_request') return;
    const method = event.method;
    if (method === 'notify') { notified = event.message === 'fixture-complete'; return; }
    methods.push(method);
    const answers = { confirm: { confirmed: true }, select: { value: 'blue' },
      input: { value: 'short' }, editor: { value: 'line1\nline2' } };
    client.respond(event.id, answers[method] || { cancelled: true });
  }, () => {});
  try {
    const result = await client.request('get_commands');
    assert(result.commands.some(c => c.source === 'skill' && c.name === 'skill:workspace-fixture'));
    assert(result.commands.some(c => c.source === 'extension' && c.name === 'workspace-fixture'));
    const response = await client.request('prompt', { message: '/workspace-fixture' });
    assert.equal(response.disposition, 'handled');
    assert.deepEqual(methods, ['confirm', 'select', 'input', 'editor']);
    assert(notified);
    console.log('PASS: Pi ' + version + ' discovers the installed skill and round-trips four extension dialogs');
    await client.request('prompt', { message: 'Replace PI_VSCODE_BEFORE in target.txt' });
    await settled(client, events);
    assert.equal(await readFile(file, 'utf8'), 'PI_VSCODE_AFTER\n', 'local fixture did not apply the expected edit');
    assert(events.some(e => e.type === 'tool_execution_end' && e.toolName === 'edit' && e.result?.details?.patch));
    assert(events.some(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta'));
    console.log('PASS: real Pi executes edit, returns its structured patch, and streams text with a local test model');
  } finally { await client.stop(); }

  if (!process.argv.includes('--live-model')) return;
  await writeFile(file, 'PI_VSCODE_BEFORE\n');
  const liveEvents = [];
  const live = new PiRpc({ ...inv, env: { ...inv.env, PI_CODING_AGENT_SESSION_DIR: join(temp, 'live-sessions') } },
    undefined, event => liveEvents.push(event), () => {});
  try {
    const state = await live.request('get_state');
    if (!['openai', 'openai-codex'].includes(state.model?.provider)) {
      console.log('SKIP: no active OpenAI model on the installed Pi');
      return;
    }
    await live.request('prompt', { message: 'In this empty test workspace, use the edit tool on target.txt to replace the exact text PI_VSCODE_BEFORE with PI_VSCODE_AFTER. Do not change anything else. Reply briefly.' });
    await settled(live, liveEvents);
    assert.equal(await readFile(file, 'utf8'), 'PI_VSCODE_AFTER\n', 'live model did not apply the expected test edit');
    assert(liveEvents.some(e => e.type === 'tool_execution_end' && e.toolName === 'edit' && e.result?.details?.patch),
      'live edit did not return a patch');
    assert(liveEvents.some(e => e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta'));
    console.log('PASS: existing OpenAI model streams, edits a scratch file, and returns a structured patch');
  } finally { await live.stop(); }
}

async function settled(client, events) {
  const deadline = Date.now() + 40000;
  while (!events.some(e => e.type === 'agent_settled')) {
    if (Date.now() > deadline || client.isClosed) throw Error('Pi did not settle');
    await new Promise(r => setTimeout(r, 100));
  }
}

main().catch(error => {
  // Do not emit Pi result data or provider errors.
  console.error('Pi smoke test failed:', error.kind || error.code || 'unexpected result');
  process.exitCode = 1;
});
