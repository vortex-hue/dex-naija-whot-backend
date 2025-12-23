require('dotenv').config();
const { Pool } = require('pg');

let pool = null;

async function initDB() {
    if (pool) return pool;

    // Try Postgres First
    if (process.env.DATABASE_URL) {
        try {
            const pgPool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: { rejectUnauthorized: false }
            });
            const client = await pgPool.connect();
            console.log('✅ Connected to PostgreSQL database');

            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS users (
                        address TEXT PRIMARY KEY,
                        xp INTEGER DEFAULT 0,
                        games_played INTEGER DEFAULT 0,
                        wins INTEGER DEFAULT 0,
                        last_match_status TEXT DEFAULT NULL
                    );
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);`);
                await client.query(`
                    CREATE TABLE IF NOT EXISTS payments (
                        tx_hash TEXT PRIMARY KEY,
                        user_address TEXT,
                        amount TEXT,
                        type TEXT,
                        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    );
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_address);`);
                console.log('✅ PostgreSQL tables initialized');
            } finally {
                client.release();
            }
            pool = pgPool;
            return pool;
        } catch (error) {
            console.warn('⚠️ PostgreSQL connection failed, falling back to SQLite:', error.message);
        }
    }

    // Fallback to SQLite
    try {
        const sqlite3 = require('sqlite3');
        const { open } = require('sqlite');

        const db = await open({
            filename: './whot.db',
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                address TEXT PRIMARY KEY,
                xp INTEGER DEFAULT 0,
                games_played INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                last_match_status TEXT DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);
            
            CREATE TABLE IF NOT EXISTS payments (
                tx_hash TEXT PRIMARY KEY,
                user_address TEXT,
                amount TEXT,
                type TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_address);
        `);

        console.log('✅ Connected to SQLite database (Fallback)');

        // Wrap SQLite to match PG interface roughly for used methods
        pool = {
            query: async (text, params) => {
                // Convert $1, $2 to ?, ? for SQLite
                let query = text.replace(/\$\d+/g, '?');
                try {
                    if (text.trim().toLowerCase().startsWith('select')) {
                        const rows = await db.all(query, params);
                        return { rows };
                    } else {
                        const result = await db.run(query, params);
                        return { rowCount: result.changes, rows: [] };
                    }
                } catch (e) {
                    console.error("SQLite Query Error:", e);
                    throw e;
                }
            }
        };
        return pool;
    } catch (error) {
        console.error('❌ Critical: Database initialization failed (PG and SQLite):', error);
        throw error;
    }
}

async function getDB() {
    if (!pool) await initDB();
    return pool;
}

// User Functions
async function getUser(address) {
    const db = await getDB();
    const res = await db.query('SELECT * FROM users WHERE address = $1', [address]);
    return res.rows[0];
}

async function createUserIfNotExists(address) {
    const db = await getDB();
    const user = await getUser(address);
    if (!user) {
        await db.query('INSERT INTO users (address) VALUES ($1)', [address]);
        return await getUser(address);
    }
    return user;
}

async function updateUserXP(address, xpToAdd, isWin) {
    const db = await getDB();
    const winIncrement = isWin ? 1 : 0;
    const status = isWin ? 'WON' : 'LOST';

    await db.query(`
    UPDATE users 
    SET xp = xp + $1, 
        games_played = games_played + 1, 
        wins = wins + $2,
        last_match_status = $3
    WHERE address = $4
  `, [xpToAdd, winIncrement, status, address]);
}

async function updateUserMatchStatus(address, status) {
    const db = await getDB();
    await db.query('UPDATE users SET last_match_status = $1 WHERE address = $2', [status, address]);
}

async function getLeaderboard(limit = 50) {
    const db = await getDB();
    const res = await db.query('SELECT address, xp, wins, games_played FROM users ORDER BY xp DESC LIMIT $1', [limit]);
    return res.rows;
}

// Payment Functions
async function recordPayment(txHash, userAddress, amount, type) {
    const db = await getDB();
    await db.query(
        'INSERT INTO payments (tx_hash, user_address, amount, type) VALUES ($1, $2, $3, $4) ON CONFLICT (tx_hash) DO NOTHING',
        [txHash, userAddress, amount, type]
    );
}

module.exports = {
    initDB,
    getDB,
    getUser,
    createUserIfNotExists,
    updateUserXP,
    updateUserMatchStatus,
    getLeaderboard,
    recordPayment
};
