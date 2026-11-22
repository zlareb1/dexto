import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { McpServerConfigSchema } from '@dexto/core/mcp';

const guide = await readFile(process.argv[2], 'utf8');
const source = guide.match(/```javascript\n([\s\S]*?)\n```/)[1];
// Keep the script next to the qualification dependencies for Node resolution.
const script = new URL('./read-loom.mjs', import.meta.url);
await writeFile(script, source);
const directory = await mkdtemp(path.join(tmpdir(), 'dexto-loom-'));
const token = 'synthetic-viewer-token';
const namespace = 'synthetic-guide';
const memoryKey = 'project/build-command';

async function run(env) {
    const child = spawn(process.execPath, [script.pathname], {
        cwd: directory,
        env: { PATH: process.env.PATH, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
        const [code, signal] = await once(child, 'close');
        assert.equal(signal, null, 'example must exit before its deadline');
        assert(!stdout.includes(token) && !stderr.includes(token), 'token must not be printed');
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

async function fixture(mode, check) {
    const seen = [];
    const calls = [];
    const invalid = [];
    const server = createServer(async (req, res) => {
        const respond = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(body === undefined ? undefined : JSON.stringify(body));
        };
        try {
            assert.equal(req.url, '/mcp');
            if (req.headers.authorization !== `Bearer ${token}`) {
                respond(401, { error: 'synthetic unauthorized request' });
                return;
            }
            if (req.method === 'GET') { respond(405); return; }
            if (req.method === 'DELETE') { respond(204); return; }
            assert.equal(req.method, 'POST');
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const message = JSON.parse(Buffer.concat(chunks).toString());
            seen.push(message.method);
            if (mode === 'auth') { respond(401, { error: 'synthetic expired token' }); return; }
            if (!Object.hasOwn(message, 'id')) { respond(202); return; }
            let result;
            switch (message.method) {
                case 'initialize':
                    result = {
                        protocolVersion: message.params.protocolVersion,
                        capabilities: { tools: {}, resources: {}, prompts: {} },
                        serverInfo: { name: 'inert-loom-contract-fixture', version: '1' },
                    };
                    break;
                case 'tools/list':
                    result = { tools: mode === 'no-tool' ? [] : [{
                        name: 'loom_op', description: 'Synthetic Loom operation contract',
                        inputSchema: {
                            type: 'object', required: ['op', 'arguments'],
                            properties: { op: { type: 'string' }, arguments: { type: 'object' } },
                        },
                    }] };
                    break;
                case 'prompts/list': result = { prompts: [] }; break;
                case 'resources/list': result = { resources: [] }; break;
                case 'tools/call': {
                    calls.push(message.params);
                    assert.deepEqual(message.params, {
                        name: 'loom_op', arguments: {
                            op: 'memory.get', arguments: { namespace, memory_key: memoryKey },
                        },
                    });
                    const value = mode === 'missing' ? { found: false } : { found: true, value: 'pnpm build' };
                    result = mode === 'tool-error'
                        ? { isError: true, content: [{ type: 'text', text: 'synthetic read refused' }] }
                        : { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
                    break;
                }
                default: assert.fail(`Unexpected MCP method: ${message.method}`);
            }
            respond(200, { jsonrpc: '2.0', id: message.id, result });
        } catch (error) {
            invalid.push(error.message);
            respond(500, { error: 'fixture contract failure' });
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const env = {
            LOOM_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
            LOOM_TOKEN: token, LOOM_NAMESPACE: namespace, LOOM_MEMORY_KEY: memoryKey,
        };
        await check(env, seen, calls);
        assert.deepEqual(invalid, []);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

try {
    await test('documented script discovers and reads one synthetic memory', async () => {
        await fixture('found', async (env, seen, calls) => {
            const result = await run(env);
            assert.equal(result.code, 0, result.stderr);
            const answer = JSON.parse(result.stdout);
            assert.deepEqual(answer.structuredContent, { found: true, value: 'pnpm build' });
            assert(seen.includes('initialize') && seen.includes('tools/list'));
            assert.equal(calls.length, 1);
        });
    });
    await test('absent synthetic memory remains a successful found:false read', async () => {
        await fixture('missing', async (env, seen, calls) => {
            const result = await run(env);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(JSON.parse(result.stdout).structuredContent.found, false);
            assert.equal(calls.length, 1);
        });
    });
    for (const mode of ['auth', 'tool-error', 'no-tool']) {
        await test(`${mode} cannot be reported as an absent memory`, async () => {
            await fixture(mode, async (env, seen, calls) => {
                const result = await run(env);
                assert.notEqual(result.code, 0);
                assert(!result.stdout.includes('"found": false'));
                assert.equal(calls.length, mode === 'tool-error' ? 1 : 0);
            });
        });
    }
    await test('all four environment values are required before a connection', async () => {
        await fixture('found', async (env, seen) => {
            for (const variable of Object.keys(env)) {
                const missing = { ...env };
                delete missing[variable];
                assert.notEqual((await run(missing)).code, 0);
            }
            assert.equal(seen.length, 0);
        });
    });
    await test('documented YAML expands the same endpoint and bearer header', () => {
        const yaml = parse(guide.match(/```yaml\n([\s\S]*?)\n```/)[1]);
        process.env.LOOM_MCP_URL = 'https://synthetic.invalid/mcp';
        process.env.LOOM_TOKEN = token;
        const config = McpServerConfigSchema.parse(yaml.mcpServers.loom);
        assert.equal(config.url, process.env.LOOM_MCP_URL);
        assert.equal(config.headers.Authorization, `Bearer ${token}`);
        assert.equal(config.connectionMode, 'strict');
    });
} finally {
    await rm(script);
    await rm(directory, { recursive: true });
}
