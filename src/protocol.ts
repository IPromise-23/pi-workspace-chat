export type ModelChoice = { provider: string; id: string; name: string };
export type SlashChoice = { name: string; description: string; source: string };
export type ContextChip = { id: string; label: string; preview?: string };
export type Row = {
  id: string; kind: 'assistant' | 'user' | 'tool';
  text: string; thinking?: string; tool?: string; summary?: string; phase?: 'running' | 'done' | 'error';
  file?: string; line?: number; patch?: string; messageError?: boolean;
};
export type Dialog = {
  id: string; method: 'select' | 'confirm' | 'input' | 'editor'; title: string;
  message?: string; options?: string[]; prefill?: string; placeholder?: string;
};
export type Snapshot = {
  host: string; folder: string; hasFolder: boolean; phase: 'disconnected' | 'connecting' | 'idle' | 'running' | 'terminal' | 'transferring';
  version?: string; notice?: string; settingsHint: boolean; session?: string;
  model?: ModelChoice; thinking?: string; models: ModelChoice[]; thinkingLevels: string[];
  slash: SlashChoice[]; commandsLoaded: boolean;
  context: ContextChip[]; dialogs: Dialog[]; rows: Row[]; toolExpanded: boolean; modifierSend: boolean;
  status: string[]; extensionTitle?: string;
};
export const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const str = (value: unknown) => typeof value === 'string' ? value : '';
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function bounded(value: unknown, max = 24000): string {
  const text = str(value);
  return text.length <= max ? text : text.slice(0, max) + '\n…';
}
export const textBlocks = (value: unknown, type = 'text', field = 'text') => {
  if (typeof value === 'string' && type === 'text') return bounded(value);
  return bounded(arr(value).map(rec).filter(item => item.type === type).map(item => bounded(item[field])).join('\n'));
};
export function modelChoice(value: unknown): ModelChoice | undefined {
  const m = rec(value);
  const provider = bounded(m.provider, 160), id = bounded(m.id, 200);
  if (!provider || !id) return;
  return { provider, id, name: bounded(m.name, 200) || id };
}
export function slashChoices(value: unknown): SlashChoice[] {
  return arr(rec(value).commands).map(rec).flatMap(c => {
    const name = bounded(c.name, 240);
    if (!name || /\s/.test(name) || name.startsWith('/')) return [];
    return [{ name, description: bounded(c.description, 300), source: bounded(c.source, 24) }];
  });
}
export function toolCall(id: string, name: string, args: unknown): Row {
  const a = rec(args);
  // Only known file-oriented Pi tools create an editor action. The host validates the path again.
  const file = ['read', 'edit', 'write'].includes(name) ? bounded(a.path, 4096) : '';
  const line = typeof a.offset === 'number' && Number.isSafeInteger(a.offset) && a.offset > 0 ? a.offset : undefined;
  return { id, kind: 'tool', tool: bounded(name, 160), text: '', phase: 'running',
    summary: bounded(file || a.command || a.pattern || a.query, 360), file: file || undefined, line };
}
export function toolOutput(row: Row, value: unknown, phase: Row['phase']): Row {
  const r = rec(value), d = rec(r.details);
  const patch = phase === 'done' && row.tool === 'edit' && typeof d.patch === 'string' &&
    d.patch.length <= 240000 ? d.patch : undefined;
  const line = typeof d.firstChangedLine === 'number' && Number.isSafeInteger(d.firstChangedLine) && d.firstChangedLine > 0
    ? d.firstChangedLine : row.line;
  return { ...row, phase, line, patch, text: textBlocks(r.content) };
}
export function messageRow(id: string, raw: unknown): Row | undefined {
  const message = rec(raw);
  if (message.role !== 'assistant' && message.role !== 'user' && message.role !== 'bashExecution') return;
  if (message.role === 'bashExecution') return {
    id, kind: 'tool', tool: 'bash', summary: bounded(message.command, 360), text: bounded(message.output),
    phase: message.cancelled || (typeof message.exitCode === 'number' && message.exitCode !== 0) ? 'error' : 'done',
  };
  const text = textBlocks(message.content);
  const thinking = message.role === 'assistant' ? textBlocks(message.content, 'thinking', 'thinking') : '';
  const imageCount = arr(message.content).filter(item => rec(item).type === 'image').length;
  const messageError = message.stopReason === 'error';
  if (!text && !thinking && !imageCount && !messageError) return;
  return {
    id, kind: message.role, text: text || (imageCount ? '[Image]' : ''), thinking: thinking || undefined, messageError,
  };
}

export function modelFailure(value: unknown): 'region' | 'quota' | 'auth' | 'network' | 'other' {
  const detail = str(value);
  if (/unsupported[_ -](country|region|territory)|(?:country|region|territory).{0,80}not supported/i.test(detail)) return 'region';
  if (/\b429\b|rate.limit|quota/i.test(detail)) return 'quota';
  if (/\b401\b|invalid.api.key|authentication|not logged in/i.test(detail)) return 'auth';
  if (/fetch failed|network error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(detail)) return 'network';
  return 'other';
}
export function historyRows(messages: unknown) {
  const rows: Row[] = [];
  const calls = new Map<string, number>();
  for (const [index, raw] of arr(messages).slice(-300).entries()) {
    const message = rec(raw);
    const row = messageRow('m' + index, raw);
    if (row) rows.push(row);
    if (message.role === 'assistant') {
      for (const c of arr(message.content).map(rec).filter(c => c.type === 'toolCall')) {
        if (!str(c.id)) continue;
        calls.set(str(c.id), rows.length);
        rows.push(toolCall('t:' + str(c.id), str(c.name), c.arguments));
      }
    } else if (message.role === 'toolResult') {
      const id = str(message.toolCallId);
      const pos = calls.get(id);
      const phase = message.isError ? 'error' : 'done';
      if (pos !== undefined) rows[pos] = toolOutput(rows[pos], message, phase);
      else rows.push(toolOutput(toolCall('r' + index, str(message.toolName), {}), message, phase));
    }
  }
  return rows.slice(-180).map(row => row.phase === 'running' ? { ...row, phase: 'error' as const } : row);
}
