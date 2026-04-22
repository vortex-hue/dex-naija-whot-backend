#!/usr/bin/env node
const { spawn } = require('child_process');
const API_TOKEN = process.env.TORQUE_API_TOKEN || process.env.TORQUE_API_KEY;
let id = 0;
function req(method, params = {}) { return JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'; }
function tool(name, args = {}) { return req('tools/call', { name, arguments: args }); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    const mcp = spawn('npx', ['-y', '@torque-labs/mcp', '--apiToken', API_TOKEN], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }
    });
    mcp.stdout.on('data', (d) => {
        for (const line of d.toString().split('\n').filter(l => l.trim())) {
            try { const p = JSON.parse(line); const t = p?.result?.content?.[0]?.text; if (t) console.log(`[${p.id}] ${t}`); } catch {}
        }
    });
    mcp.stderr.on('data', () => {});
    await delay(5000);
    mcp.stdin.write(req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '1.0.0' } }));
    await delay(3000);
    mcp.stdin.write(tool('set_active_project', { projectId: 'cmo9mdh4300t8l91i8fhhbhna' }));
    await delay(3000);
    console.log('Getting incentive details...');
    mcp.stdin.write(tool('get_recurring_incentive', { recurringOfferId: 'cmo9q5rzq00tql91imczk47wd' }));
    await delay(5000);
    mcp.kill();
    process.exit(0);
}
run();
