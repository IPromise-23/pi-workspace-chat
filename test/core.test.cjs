const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const test = require('node:test');
const { JsonLines, PiRpc } = require('../dist/test/rpc.cjs');
const { resolveInvocation, probeVersion } = require('../dist/test/launch.cjs');
const { modelChoice, modelFailure, historyRows } = require('../dist/test/protocol.cjs');
const { listSessions, readSession } = require('../dist/test/sessions.cjs');

const fake = resolve(__dirname, 'fake-pi.cjs');
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-workspace-rpc-')));
  const trace = join(cwd, 'trace.txt');
  const invocation = {
    command: fake, cwd, env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
      PI_SMOKE_STORE: cwd, PI_SMOKE_TRACE: trace },
  };
  const events = [], exits = [];
  const client = new PiRpc(invocation, undefined, event => events.push(event), error => exits.push(error));
  return { cwd, trace, invocation, events, exits, client };
}

test('JSONL preserves Unicode separators, split multibyte text, and CRLF', () => {
  const rows = [];
  const wire = new JsonLines();
  const raw = { type: 'message', value: '中🙂\u2028\u2029' };
  for (const byte of Buffer.from(JSON.stringify(raw) + '\r\n')) wire.push(Buffer.from([byte]), r => rows.push(r));
  assert.deepEqual(rows, [raw]);
  assert.throws(() => wire.push(Buffer.from('[]\n'), () => {}));
});

test('RPC correlates concurrent requests and preserves streamed events before the prompt ack', async t => {
  const { client, events } = await fixture();
  t.after(() => client.stop());
  const [state, tools] = await Promise.all([client.request('get_state'), client.request('get_commands')]);
  assert.equal(state.model.id, 'fixture');
  assert.equal(tools.commands[0].name, 'fixture');
  const result = await client.request('prompt', { message: 'hello' });
  assert.equal(result.disposition, 'started');
  assert(events.some(e => e.type === 'message_update' && e.assistantMessageEvent.delta.includes('\u2028')));
  assert(events.some(e => e.type === 'agent_settled'));
});

test('RPC answers a dialog by ID while the command is pending and can abort a running prompt', async t => {
  const { client, events } = await fixture();
  t.after(() => client.stop());
  const waiting = client.request('prompt', { message: '/fixture' });
  await until(() => events.find(e => e.type === 'extension_ui_request'));
  client.respond('fixture-dialog', { confirmed: true });
  assert.deepEqual(await waiting, { disposition: 'handled', confirmation: true });
  await client.request('prompt', { message: 'hold' });
  await client.request('abort');
  await until(() => events.some(e => e.type === 'agent_settled' && e.aborted === true));
});

test('exit rejects a pending prompt instead of silently resending', async t => {
  const { client, exits } = await fixture();
  t.after(() => client.stop());
  await assert.rejects(client.request('prompt', { message: 'exit' }), { kind: 'closed' });
  assert.equal(exits.length, 1);
  assert(client.isClosed);
});

test('orderly handoff waits for shutdown before another process opens the same session', async t => {
  const { client, invocation, trace } = await fixture();
  const session = await client.request('get_state');
  await client.request('prompt', { message: 'original' });
  await client.stop();
  const next = new PiRpc(invocation, session.sessionFile, () => {}, () => {});
  t.after(() => next.stop());
  const history = await next.request('get_messages');
  assert.equal(history.messages[0].content, 'original');
  const traceRows = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(traceRows.map(row => row.phase), ['rpc-start', 'rpc-end', 'rpc-start']);
  assert(traceRows.every(row => row.file === session.sessionFile));
});

test('launcher resolves GUI PATH fallback and preserves machine-scoped Node override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-workspace-home-'));
  const bin = join(home, '.npm-global', 'bin');
  await mkdir(bin, { recursive: true });
  const pi = join(bin, 'pi');
  await writeFile(pi, await readFile(fake));
  await chmod(pi, 0o700);
  const invocation = await resolveInvocation(home, '', dirname(process.execPath),
    { PATH: '/usr/bin:/bin', PI_SESSION_ID: 'previous', PI_SESSION_FILE: '/elsewhere' }, 'darwin', home);
  assert.equal(invocation.command, pi);
  assert.equal(invocation.env.PATH.split(':')[0], dirname(process.execPath));
  assert(!('PI_SESSION_ID' in invocation.env));
  assert(!('PI_SESSION_FILE' in invocation.env));
  assert.equal(await probeVersion(invocation), '1.5.0');
  await assert.rejects(resolveInvocation(home, './pi', '', {}, 'darwin', home), { kind: 'piPath' });
});

test('session discovery lists only saved sessions in the selected folder', async () => {
  const { client, cwd } = await fixture();
  const { sessionFile } = await client.request('get_state');
  await client.stop();
  const other = await mkdtemp(join(tmpdir(), 'pi-workspace-other-'));
  const wrong = join(cwd, 'other.jsonl');
  await writeFile(wrong, JSON.stringify({ type: 'session', cwd: other, id: 'wrong' }) + '\n');
  assert.equal(await readSession(wrong, cwd), undefined);
  assert.deepEqual((await listSessions(sessionFile, cwd, [])).map(x => x.file), [sessionFile]);
});

test('model metadata and tool patches cross the Webview boundary without provider configuration', () => {
  assert.deepEqual(modelChoice({ provider: 'openai', id: 'x', name: 'X', apiKey: 'never-forward' }),
    { provider: 'openai', id: 'x', name: 'X' });
  const rows = historyRows([
    { role: 'assistant', content: [{ type: 'toolCall', id: '1', name: 'edit', arguments: { path: 'x.ts' } }] },
    { role: 'toolResult', toolCallId: '1', content: [{ type: 'text', text: 'done' }], details: { patch: '-before\n+after' } },
  ]);
  assert.equal(rows[0].patch, '-before\n+after');
  assert.equal(rows[0].file, 'x.ts');
  assert.equal(modelFailure('HTTP 403 unsupported_country_region_territory'), 'region');
});

async function until(fn, limit = 5000) {
  const deadline = Date.now() + limit;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Pi fixture');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
