#!/usr/bin/env node
'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv.includes('--version')) { console.log('1.5.0'); process.exit(); }
const cwd = process.cwd();
const store = process.env.PI_SMOKE_STORE || cwd;
const found = process.argv.indexOf('--session');
let file = found > 0 ? process.argv[found + 1] : path.join(store, randomUUID() + '.jsonl');
let id;
let messages;
function load() {
  if (!fs.existsSync(file)) {
    id = randomUUID();
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd }) + '\n');
  }
  const [header, ...entries] = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse);
  id = header.id; messages = entries.map(entry => entry.message);
}
function track(phase) {
  if (process.env.PI_SMOKE_TRACE) fs.appendFileSync(process.env.PI_SMOKE_TRACE, JSON.stringify({ phase, file, cwd }) + '\n');
}
load();
if (!process.argv.includes('rpc')) {
  track('terminal-start');
  process.on('SIGTERM', () => process.exit());
  process.on('SIGHUP', () => process.exit());
  process.stdin.resume();
  return;
}
track('rpc-start');
const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', baseUrl: 'private-placeholder' };
const emit = x => process.stdout.write(JSON.stringify(x) + '\n');
const respond = (msg, data) => emit({ type: 'response', id: msg.id, command: msg.type, success: true, data });
const append = message => {
  messages.push(message);
  fs.appendFileSync(file, JSON.stringify({ type: 'message', message }) + '\n');
  emit({ type: 'message_end', message });
};
function settled(text, aborted = false) {
  const message = { role: 'assistant', content: [{ type: 'text', text }] };
  emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  append(message);
  emit({ type: 'agent_end' });
  emit({ type: 'agent_settled', aborted });
}
let request;
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', input => {
  const msg = JSON.parse(input);
  if (msg.type === 'get_state') respond(msg, { sessionFile: file, sessionId: id, model, thinkingLevel: 'off' });
  else if (msg.type === 'get_available_models') respond(msg, { models: [model] });
  else if (msg.type === 'get_available_thinking_levels') respond(msg, { levels: ['off', 'low'] });
  else if (msg.type === 'get_messages') respond(msg, { messages });
  else if (msg.type === 'get_commands') respond(msg, { commands: [{ name: 'fixture', source: 'extension', description: 'Test an extension dialog' }] });
  else if (msg.type === 'new_session') {
    file = path.join(store, randomUUID() + '.jsonl'); load(); track('new-session'); respond(msg, { cancelled: false });
  } else if (msg.type === 'switch_session') {
    file = msg.sessionPath; load(); track('switch-session'); respond(msg, { cancelled: false });
  } else if (msg.type === 'prompt') {
    if (msg.message === 'exit') { process.exit(4); }
    if (msg.message === 'hold') { emit({ type: 'agent_start' }); respond(msg, { disposition: 'started' }); return; }
    if (msg.message === '/fixture') {
      request = msg;
      emit({ type: 'extension_ui_request', id: 'fixture-dialog', method: 'confirm', title: 'Allow fixture?' });
      return;
    }
    emit({ type: 'agent_start' });
    append({ role: 'user', content: msg.message });
    settled('Hello Pi 🙂 separator\u2028still one line');
    respond(msg, { disposition: 'started' });
  } else if (msg.type === 'abort') {
    respond(msg); settled('Stopped', true);
  } else if (msg.type === 'extension_ui_response' && msg.id === 'fixture-dialog' && request) {
    respond(request, { disposition: 'handled', confirmation: msg.confirmed });
    request = undefined;
  } else respond(msg);
}).on('close', () => track('rpc-end'));
