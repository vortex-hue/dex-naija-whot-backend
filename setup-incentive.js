#!/usr/bin/env node
/**
 * Creates the weekly leaderboard incentive via Torque MCP
 * Events are already attached to project
 */
const { spawn } = require('child_process');
const API_TOKEN = process.env.TORQUE_API_TOKEN || process.env.TORQUE_API_KEY;
const PROJECT_ID = 'cmo9mdh4300t8l91i8fhhbhna';
const GAME_WON_EVENT = 'cmo9mc7j600swl91ixv8psgyh';

let requestId = 0;
function req(method, params = {}) {
    return JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }) + '\n';
}
function tool(name, args = {}) { return req('tools/call', { name, arguments: args }); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    if (!API_TOKEN) { console.error('❌ TORQUE_API_KEY not set'); process.exit(1); }

    const mcp = spawn('npx', ['-y', '@torque-labs/mcp', '--apiToken', API_TOKEN], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` }
    });

    const responses = [];
    let buffer = '';

    mcp.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const p = JSON.parse(line);
                    responses.push(p);
                    const text = p?.result?.content?.[0]?.text || '';
                    if (text) console.log(`  [${p.id}] ${text.substring(0, 600)}`);
                } catch (e) {}
            }
        }
    });

    mcp.stderr.on('data', (d) => {
        const m = d.toString().trim();
        if (m && !m.includes('npm warn') && !m.includes('npm info'))
            console.log('  ⚠️', m.substring(0, 200));
    });

    await delay(5000);

    // Initialize
    mcp.stdin.write(req('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'whot-setup', version: '1.0.0' }
    }));
    await delay(3000);

    // Set project
    console.log('\n1️⃣  Setting project...');
    mcp.stdin.write(tool('set_active_project', { projectId: PROJECT_ID }));
    await delay(3000);

    // Verify events are attached
    console.log('\n2️⃣  Verifying events...');
    mcp.stdin.write(tool('list_project_events'));
    await delay(3000);

    // Generate query
    console.log('\n3️⃣  Generating incentive query...');
    mcp.stdin.write(tool('generate_incentive_query', {
        source: 'custom_event',
        customEventId: GAME_WON_EVENT,
        valueExpression: 'COUNT(*)',
        groupByPubkey: true,
        orderBy: 'DESC',
        confirmed: true
    }));
    await delay(5000);

    // Extract SQL from response
    let sqlQuery = null;
    for (const r of responses) {
        const text = r?.result?.content?.[0]?.text || '';
        const match = text.match(/```sql\n([\s\S]*?)\n```/) || text.match(/`(SELECT[\s\S]*?)`/);
        if (match) { sqlQuery = match[1]; break; }
    }

    if (!sqlQuery) {
        console.log('\n⚠️ Could not extract SQL, using manual query...');
        // Wait and check latest
        await delay(2000);
        for (const r of responses) {
            const text = r?.result?.content?.[0]?.text || '';
            if (text.includes('SELECT')) {
                const m = text.match(/SELECT[\s\S]*?(?=\n\n|$)/);
                if (m) sqlQuery = m[0];
            }
        }
    }

    if (sqlQuery) {
        console.log(`\n📝 SQL Query: ${sqlQuery.substring(0, 300)}`);

        // Create incentive (preview first)
        console.log('\n4️⃣  Creating incentive (preview)...');
        mcp.stdin.write(tool('create_recurring_incentive', {
            name: 'Weekly WhotChain Leaderboard',
            description: 'Top Whot game winners earn SOL weekly. 1 win = 1 point. Top players ranked by total wins.',
            type: 'leaderboard',
            emissionType: 'SOL',
            totalFundAmount: 0.1,
            interval: 'WEEKLY',
            startDate: '2026-04-22T00:00:00Z',
            sqlQuery: sqlQuery,
            customEventId: GAME_WON_EVENT,
            customFormula: 'N'
        }));
        await delay(5000);

        // Now confirm
        console.log('\n5️⃣  Creating incentive (confirmed)...');
        mcp.stdin.write(tool('create_recurring_incentive', {
            name: 'Weekly WhotChain Leaderboard',
            description: 'Top Whot game winners earn SOL weekly. 1 win = 1 point. Top players ranked by total wins.',
            type: 'leaderboard',
            emissionType: 'SOL',
            totalFundAmount: 0.1,
            interval: 'WEEKLY',
            startDate: '2026-04-22T00:00:00Z',
            sqlQuery: sqlQuery,
            customEventId: GAME_WON_EVENT,
            customFormula: 'N',
            confirmed: true
        }));
        await delay(8000);
    } else {
        console.log('\n❌ Could not generate SQL query');
    }

    // Print summary
    console.log('\n\n========== ALL RESULTS ==========');
    for (const r of responses) {
        const text = r?.result?.content?.[0]?.text;
        if (text) console.log(`\n[${r.id}] ${text.substring(0, 600)}`);
    }

    mcp.kill();
    process.exit(0);
}

run().catch(e => { console.error('❌', e); process.exit(1); });
