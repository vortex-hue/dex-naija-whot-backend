/**
 * Torque Event Emitter
 * Fires custom events to Torque's ingestion pipeline.
 * Events are fire-and-forget — if Torque is unreachable, the game continues.
 */

const TORQUE_INGEST_URL = 'https://ingest.torque.so/events';
const API_KEY = process.env.TORQUE_INGEST_API_KEY;

/**
 * Fire a custom event to Torque's ingestion endpoint
 * @param {string} eventName - The registered Torque event name (e.g., 'whot_game_won')
 * @param {string} walletAddress - Solana wallet pubkey (base58)
 * @param {object} data - Additional event properties matching the registered schema
 */
async function fireTorqueEvent(eventName, walletAddress, data = {}) {
    if (!API_KEY) {
        console.warn('⚠️ TORQUE_INGEST_API_KEY not set, skipping event:', eventName);
        return;
    }

    if (!walletAddress) {
        console.warn('⚠️ No wallet address provided, skipping Torque event:', eventName);
        return;
    }

    try {
        const res = await fetch(TORQUE_INGEST_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            },
            body: JSON.stringify({
                userPubkey: walletAddress,
                timestamp: Date.now(),
                eventName,
                data
            })
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`❌ Torque event failed [${eventName}]:`, errorText);
        } else {
            console.log(`📡 Torque event fired: ${eventName} for ${walletAddress.slice(0, 8)}...`);
        }
    } catch (err) {
        // Non-blocking — game continues even if Torque is down
        console.error(`❌ Torque event error [${eventName}]:`, err.message);
    }
}

/**
 * Fire multiple events at once (non-blocking, parallel)
 */
async function fireTorqueEvents(events) {
    await Promise.allSettled(
        events.map(({ eventName, wallet, data }) => fireTorqueEvent(eventName, wallet, data))
    );
}

module.exports = { fireTorqueEvent, fireTorqueEvents };
