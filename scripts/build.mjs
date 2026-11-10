import { build } from 'esbuild';

await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node',
    target: 'node22', format: 'cjs', external: ['vscode'], outfile: 'dist/extension.cjs' }),
  build({ entryPoints: ['src/webview.ts'], bundle: true, platform: 'browser',
    target: 'es2022', format: 'iife', outfile: 'dist/webview.js' }),
  build({ entryPoints: ['src/rpc.ts', 'src/launch.ts', 'src/protocol.ts', 'src/sessions.ts'],
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist/test',
    outExtension: { '.js': '.cjs' } }),
]);
