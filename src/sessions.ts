import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { rec, str } from './protocol';

export type Session = { file: string; id: string; updated: number; name?: string };

export function inside(root: string, file: string) {
  const r = relative(root, file);
  return r !== '' && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
}

export async function readSession(file: string, cwd: string): Promise<Session | undefined> {
  if (!isAbsolute(file) || extname(file) !== '.jsonl') return;
  try {
    const safePath = await realpath(file);
    if (extname(safePath) !== '.jsonl') return;
    const metadata = await stat(safePath);
    if (!metadata.isFile()) return;
    const f = await open(safePath, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const { bytesRead } = await f.read(buf);
      const lf = buf.indexOf(10);
      if (lf < 0 || lf >= bytesRead) return;
      const h = rec(JSON.parse(buf.subarray(0, lf).toString('utf8')));
      const id = str(h.id), headerCwd = str(h.cwd);
      if (h.type !== 'session' || !id || !isAbsolute(headerCwd) || await realpath(headerCwd) !== cwd) return;
      return { file: safePath, id, updated: metadata.mtimeMs };
    } finally { await f.close(); }
  } catch { return; }
}

export async function listSessions(sessionFile: string | undefined, cwd: string, recent: Session[]) {
  const seen = new Map<string, Session>();
  const names = new Map(recent.map(s => [s.file, s.name]));
  const files = recent.slice(0, 100).map(s => s.file);
  if (sessionFile && isAbsolute(sessionFile)) {
    try {
      const dir = await realpath(dirname(sessionFile));
      const entries = (await readdir(dir, { withFileTypes: true })).filter(e =>
        e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort().reverse().slice(0, 100);
      files.push(...entries.map(name => join(dir, basename(name))));
    } catch { /* the store may not exist until the first conversation */ }
  }
  for (const file of new Set(files)) {
    const s = await readSession(file, cwd);
    if (s) seen.set(s.file, { ...s, name: names.get(s.file) });
  }
  return [...seen.values()].sort((a, b) => b.updated - a.updated).slice(0, 100);
}
