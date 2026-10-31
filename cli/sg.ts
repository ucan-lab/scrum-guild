#!/usr/bin/env node
import { homedir } from 'node:os';
import { fileConfigStore } from './lib/config-file.ts';
import { main } from './lib/main.ts';

const configHome = process.env.XDG_CONFIG_HOME || `${homedir()}/.config`;
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
