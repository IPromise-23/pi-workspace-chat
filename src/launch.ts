import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Invocation } from './rpc';

const exec = promisify(execFile);
export class LaunchError extends Error {
  constructor(readonly kind: 'unsupported' | 'piPath' | 'nodeDirectory' | 'missing' | 'node' | 'version') {
    super(kind);
  }
}

async function executable(file: string) {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); }
  catch { return false; }
}

export async function resolveInvocation(cwd: string, piPath: string, nodeDirectory: string,
  inherited = process.env, platform = process.platform, home = homedir()): Promise<Invocation> {
  if (platform !== 'darwin' && platform !== 'linux') throw new LaunchError('unsupported');
  const explicit = piPath.trim();
  const node = nodeDirectory.trim();
  if (explicit && (!isAbsolute(explicit) || !(await executable(explicit)))) throw new LaunchError('piPath');
  if (node && (!isAbsolute(node) || !(await executable(join(node, 'node'))))) throw new LaunchError('nodeDirectory');

  const system = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] :
    ['/usr/local/bin', '/usr/bin', '/bin'];
  const user = [join(home, '.npm-global', 'bin'), join(home, '.local', 'bin')];
  const paths = (inherited.PATH ?? '').split(delimiter).filter(p => isAbsolute(p));
  const search = [...new Set([...paths, ...user, ...system])];
  let command = explicit;
  if (!command) {
    for (const dir of search) {
      const candidate = join(dir, 'pi');
      if (await executable(candidate)) { command = candidate; break; }
    }
  }
  if (!command) throw new LaunchError('missing');

  const env: NodeJS.ProcessEnv = { ...inherited,
    PATH: [...new Set([...(node ? [node] : []), dirname(command), ...search])].join(delimiter) };
  // A VS Code instance opened from inside Pi must start its own session.
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  return { command, cwd, env };
}

export async function probeVersion(invocation: Invocation) {
  let output: string;
  try {
    const result = await exec(invocation.command, ['--version'], {
      cwd: invocation.cwd, env: invocation.env, timeout: 8000, maxBuffer: 65536, windowsHide: true,
    });
    output = result.stdout;
  } catch { throw new LaunchError('node'); }
  const match = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 5)) {
    throw new LaunchError('version');
  }
  return match[0];
}
