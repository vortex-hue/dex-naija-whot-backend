#!/usr/bin/env node
/**
 * Torque Event Registration Script
 * Run once to register all WhotChain custom events on Torque.
 * 
 * Usage: node src/torque/register-events.js
 * 
 * Prerequisites: TORQUE_API_KEY and TORQUE_API_URL must be set in .env
 */

require('dotenv').config();

const API_URL = process.env.TORQUE_API_URL || 'https://server.torque.so';
const API_KEY = process.env.TORQUE_API_KEY;

if (!API_KEY) {
    console.error('❌ TORQUE_API_KEY not set in .env');
    process.exit(1);
}

const EVENTS = [
    { name: 'Whot Game Won', eventName: 'whot_game_won', fields: [{ fieldName: 'points', type: 'number' }, { fieldName: 'mode', type: 'string' }] },
    { name: 'Whot Game Played', eventName: 'whot_game_played', fields: [{ fieldName: 'points', type: 'number' }, { fieldName: 'mode', type: 'string' }] },
    { name: 'Whot Daily Login', eventName: 'whot_daily_login', fields: [{ fieldName: 'streak', type: 'number' }] },
    { name: 'Whot PvP Won', eventName: 'whot_pvp_won', fields: [{ fieldName: 'points', type: 'number' }, { fieldName: 'room_id', type: 'string' }] },
    { name: 'Whot 7 Day Streak', eventName: 'whot_streak_7', fields: [{ fieldName: 'streak', type: 'number' }] },
    { name: 'Whot 30 Day Streak', eventName: 'whot_streak_30', fields: [{ fieldName: 'streak', type: 'number' }] },
];

async function main() {
    const headers = {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
    };

    // 1. List existing events
    console.log('📋 Checking existing events...');
    const listRes = await fetch(API_URL + '/events', { headers });
    const existing = (await listRes.json()).data || [];
    const existingNames = existing.map(e => e.eventName);

    // 2. Register missing events
    for (const evt of EVENTS) {
        if (existingNames.includes(evt.eventName)) {
            const existingEvt = existing.find(e => e.eventName === evt.eventName);
            console.log(`  ✅ ${evt.eventName} already exists (${existingEvt.id})`);
            continue;
        }

        const res = await fetch(API_URL + '/events', {
            method: 'POST',
            headers,
            body: JSON.stringify(evt)
        });
        const data = await res.json();
        if (res.ok) {
            console.log(`  ✅ Created ${evt.eventName} -> ${data.data.id}`);
        } else {
            console.log(`  ❌ Failed ${evt.eventName}: ${data.message}`);
        }
    }

    // 3. Summary
    console.log('\n📊 Event IDs for .env:');
    const finalRes = await fetch(API_URL + '/events', { headers });
    const finalData = (await finalRes.json()).data || [];
    finalData.filter(e => e.eventName.startsWith('whot_')).forEach(e => {
        const envKey = 'TORQUE_EVENT_' + e.eventName.replace('whot_', '').toUpperCase();
        console.log(`${envKey}=${e.id}`);
    });

    console.log('\n✅ All events registered and ready for ingestion.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
