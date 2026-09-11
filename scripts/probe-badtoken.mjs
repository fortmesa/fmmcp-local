import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const creds = JSON.parse(await readFile(join(homedir(), '.fmcode', 'credentials.json'), 'utf8'));
const base = creds.environments.sandbox.fortmesa_api_base;
const gw = spawn('yarn', ['node', 'dist/server/index.js', '--http', '--port', '3023'], {
  cwd: '/workspaces/fmmcp-gw',
  env: { ...process.env, CONTINURISK_API_URL: base },
  stdio: ['ignore', 'ignore', 'ignore'],
});
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch('http://localhost:3023/health')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

// FORTMESA_API_TOKEN=garbage must take PRECEDENCE over the (valid) credentials file
const transport = new StdioClientTransport({
  command: 'yarn',
  args: ['node', 'dist/local-mcp/cli.js', '--env', 'sandbox', '--gateway', 'http://localhost:3023/mcp'],
  cwd: '/workspaces/fmmcp-local',
  env: { ...process.env, FORTMESA_API_TOKEN: 'garbage-token-precedence-test' },
});
const client = new Client({ name: 'probe', version: '0' });
await client.connect(transport);

const r1 = await client.callTool({ name: 'grc_scopes', arguments: { method: 'list' } });
const t1 = r1.content?.[0]?.text ?? '';
console.log('call1 isError:', r1.isError === true, '| 401-ish:', /401|Unauthorized/i.test(t1));

// Proxy must SURVIVE the failure — second call still answers
const r2 = await client.callTool({
  name: 'grc_documents_read',
  arguments: { method: 'list', scopeId: '5da7314e388a0c6302e1f776' },
});
console.log('call2 (local tool) isError:', r2.isError === true, '| proxy alive:', true);

const ok = r1.isError === true && /401|Unauthorized/i.test(t1) && r2.isError === true;
console.log(ok ? 'PRECEDENCE+RESILIENCE: PASS' : 'PRECEDENCE+RESILIENCE: FAIL');
await client.close();
gw.kill('SIGTERM');
process.exit(ok ? 0 : 1);
