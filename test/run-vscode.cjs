const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pi-workspace-vscode-'));
const workspace = join(temp, 'workspace');
const store = join(temp, 'sessions');
mkdirSync(workspace);
mkdirSync(store);
const vscode = process.env.VSCODE_TEST_EXECUTABLE ??
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const result = spawnSync(vscode, [
  '--user-data-dir', join(temp, 'profile'), '--extensions-dir', join(temp, 'extensions'),
  '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates',
  '--disable-workspace-trust', '--disable-telemetry',
  '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + join(__dirname, 'vscode-smoke.cjs'),
  workspace,
], {
  env: { ...process.env, PI_SMOKE_EXECUTABLE: join(__dirname, 'fake-pi.cjs'),
    PI_SMOKE_TRACE: join(temp, 'trace.txt'), PI_SMOKE_STORE: store, PI_SMOKE_NODE: dirname(process.execPath) },
  encoding: 'utf8', timeout: 60000, maxBuffer: 3 * 1024 * 1024,
});
if (result.error) console.error('VS Code smoke test could not finish:', result.error.code || 'unknown');
for (const line of (result.stdout + '\n' + result.stderr).split('\n').filter(x =>
  /PASS:|AssertionError|Missing VS Code smoke event|vscode-smoke\.cjs/.test(x)).slice(-12)) console.log(line);
process.exitCode = result.status ?? 1;
