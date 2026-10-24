// pnpm dev: vite dev（画面、HMR）と wrangler dev（API）を並べて立てる。vite が /api を wrangler dev へ転送する。
// pnpm preview（--preview）: build 済みの build/ と API を、本番と同じ配り方で wrangler dev だけで配る。
// どちらかが止まったら残りも止める。ポートがぶつかったときに片方だけ動き続けないようにするため。
import { spawn, type ChildProcess } from 'node:child_process';
import { devPorts } from './dev-ports.ts';

const preview = process.argv.includes('--preview');
const ports = devPorts(process.env);
const version = process.env.APP_VERSION;

const wranglerArgs = [
  'dev',
  '--port',
  String(ports.api),
  '--inspector-port',
  String(ports.inspector),
  ...(version ? ['--var', `APP_VERSION:${version}`] : []),
];

const commands: [string, string[]][] = preview
  ? [['wrangler', wranglerArgs]]
  : [
      ['wrangler', wranglerArgs],
      ['vite', ['dev']],
    ];

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

for (const [command, args] of commands) {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`${command} を起動できませんでした: ${err.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`${command} が止まりました（${signal ?? code}）。残りも止めます`);
    stopAll(code ?? 1);
  });
  children.push(child);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stopAll(0));
}

console.log(
  preview
    ? `preview: http://localhost:${ports.api}`
    : `dev: http://localhost:${ports.app}（API は http://localhost:${ports.api}）`,
);
