#!/usr/bin/env node
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileConfigStore } from './lib/config-file.ts';
import { main } from './lib/main.ts';

// XDG の仕様: XDG_CONFIG_HOME は絶対パスのときだけ使う。空や相対パスは未設定と同じ
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
const configHome = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : `${homedir()}/.config`;
const config = fileConfigStore(`${configHome}/scrum-guild/config.json`);
const code = await main(process.argv.slice(2), {
  fetch,
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin)
      chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    return new TextDecoder().decode(Buffer.concat(chunks));
  },
  config,
});
process.exitCode = code;
