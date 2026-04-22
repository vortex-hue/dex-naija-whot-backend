require('dotenv').config();

let dbType = null;
let mongoose = null;
let sqlitePool = null;

// Mongoose Models
let User = null;
let Payment = null;

async function initDB() {
    if (dbType) return; // already initialized

    // Try MongoDB First
    if (process.env.MONGODB_URI) {
        try {
            mongoose = require('mongoose');
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('✅ Connected to MongoDB database');
            dbType = 'mongodb';

            const userSchema = new mongoose.Schema({
                address: { type: String, required: true, unique: true },
                xp: { type: Number, default: 0 },
                points: { type: Number, default: 0 },
                weekly_points: { type: Number, default: 0 },
                games_played: { type: Number, default: 0 },
                wins: { type: Number, default: 0 },
                last_match_status: { type: String, default: null },
                streak_count: { type: Number, default: 0 },
                last_played_date: { type: String, default: null },
                solana_address: { type: String, default: null }
            });

            const paymentSchema = new mongoose.Schema({
                tx_hash: { type: String, required: true, unique: true },
                user_address: { type: String },
                amount: { type: String },
                type: { type: String },
                timestamp: { type: Date, default: Date.now }
            });

            User = mongoose.models.User || mongoose.model('User', userSchema);
            Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

            return;
        } catch (error) {
            console.warn('⚠️ MongoDB connection failed, falling back to SQLite:', error.message);
            // reset to allow fallback
            mongoose = null;
            dbType = null;
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
                points INTEGER DEFAULT 0,
                weekly_points INTEGER DEFAULT 0,
                games_played INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                last_match_status TEXT DEFAULT NULL,
                streak_count INTEGER DEFAULT 0,
                last_played_date TEXT DEFAULT NULL,
                solana_address TEXT DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_users_xp ON users(xp DESC);
            CREATE INDEX IF NOT EXISTS idx_users_points ON users(points DESC);
            
            CREATE TABLE IF NOT EXISTS payments (
                tx_hash TEXT PRIMARY KEY,
                user_address TEXT,
                amount TEXT,
                type TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_address);
        `);

        // Migrate existing tables — add new columns if they don't exist
        const columns = await db.all("PRAGMA table_info(users)");
        const columnNames = columns.map(c => c.name);
        const migrations = [
            { name: 'points', sql: 'ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0' },
            { name: 'weekly_points', sql: 'ALTER TABLE users ADD COLUMN weekly_points INTEGER DEFAULT 0' },
            { name: 'streak_count', sql: 'ALTER TABLE users ADD COLUMN streak_count INTEGER DEFAULT 0' },
            { name: 'last_played_date', sql: 'ALTER TABLE users ADD COLUMN last_played_date TEXT DEFAULT NULL' },
            { name: 'solana_address', sql: 'ALTER TABLE users ADD COLUMN solana_address TEXT DEFAULT NULL' }
        ];
        for (const m of migrations) {
            if (!columnNames.includes(m.name)) {
                await db.exec(m.sql);
                console.log(`  📦 Added column: ${m.name}`);
            }
        }

        console.log('✅ Connected to SQLite database (Fallback)');
        dbType = 'sqlite';

        sqlitePool = {
            query: async (text, params) => {
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
        return;
    } catch (error) {
        console.error('❌ Critical: Database initialization failed (MongoDB and SQLite):', error);
        throw error;
    }
}

async function getDB() {
    if (!dbType) await initDB();
    return sqlitePool; 
}

// ========================
// User Functions
// ========================

async function getUser(address) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        const user = await User.findOne({ address }).lean();
        return user;
    } else {
        const db = await getDB();
        const res = await db.query('SELECT * FROM users WHERE address = $1', [address]);
        return res.rows[0];
    }
}

async function createUserIfNotExists(address) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        let user = await User.findOne({ address }).lean();
        if (!user) {
            const newUser = new User({ address });
            await newUser.save();
            return newUser.toObject();
        }
        return user;
    } else {
        const db = await getDB();
        const res = await db.query('SELECT * FROM users WHERE address = $1', [address]);
        if (!res.rows[0]) {
            await db.query('INSERT INTO users (address) VALUES ($1)', [address]);
            const newRes = await db.query('SELECT * FROM users WHERE address = $1', [address]);
            return newRes.rows[0];
        }
        return res.rows[0];
    }
}

async function updateUserXP(address, xpToAdd, isWin) {
    if (!dbType) await initDB();
    const winIncrement = isWin ? 1 : 0;
    const status = isWin ? 'WON' : 'LOST';

    if (dbType === 'mongodb') {
        await User.updateOne(
            { address },
            { 
                $inc: { xp: xpToAdd, games_played: 1, wins: winIncrement },
                $set: { last_match_status: status }
            }
        );
    } else {
        const db = await getDB();
        await db.query(`
        UPDATE users 
        SET xp = xp + $1, 
            games_played = games_played + 1, 
            wins = wins + $2,
            last_match_status = $3
        WHERE address = $4
      `, [xpToAdd, winIncrement, status, address]);
    }
}

async function updateUserMatchStatus(address, status) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        await User.updateOne({ address }, { $set: { last_match_status: status } });
    } else {
        const db = await getDB();
        await db.query('UPDATE users SET last_match_status = $1 WHERE address = $2', [status, address]);
    }
}

async function getLeaderboard(limit = 50) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        const users = await User.find({}, 'address xp points wins games_played streak_count').sort({ points: -1 }).limit(limit).lean();
        return users;
    } else {
        const db = await getDB();
        const res = await db.query('SELECT address, xp, points, wins, games_played, streak_count FROM users ORDER BY points DESC LIMIT $1', [limit]);
        return res.rows;
    }
}

// ========================
// Points & Streak Functions
// ========================

async function addPoints(address, pointsToAdd) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        await User.updateOne(
            { address },
            { $inc: { points: pointsToAdd, weekly_points: pointsToAdd } }
        );
    } else {
        const db = await getDB();
        await db.query(
            'UPDATE users SET points = points + $1, weekly_points = weekly_points + $2 WHERE address = $3',
            [pointsToAdd, pointsToAdd, address]
        );
    }
}

async function updateStreak(address, newStreak, todayDate) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        await User.updateOne(
            { address },
            { $set: { streak_count: newStreak, last_played_date: todayDate } }
        );
    } else {
        const db = await getDB();
        await db.query(
            'UPDATE users SET streak_count = $1, last_played_date = $2 WHERE address = $3',
            [newStreak, todayDate, address]
        );
    }
}

async function resetWeeklyPoints() {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        await User.updateMany({}, { $set: { weekly_points: 0 } });
    } else {
        const db = await getDB();
        await db.query('UPDATE users SET weekly_points = 0', []);
    }
    console.log('🔄 Weekly points reset complete');
}

async function getWeeklyLeaderboard(limit = 50) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        const users = await User.find({ weekly_points: { $gt: 0 } }, 'address weekly_points solana_address streak_count')
            .sort({ weekly_points: -1 }).limit(limit).lean();
        return users;
    } else {
        const db = await getDB();
        const res = await db.query(
            'SELECT address, weekly_points, solana_address, streak_count FROM users WHERE weekly_points > 0 ORDER BY weekly_points DESC LIMIT $1',
            [limit]
        );
        return res.rows;
    }
}

async function linkSolanaAddress(address, solanaAddress) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        await User.updateOne({ address }, { $set: { solana_address: solanaAddress } });
    } else {
        const db = await getDB();
        await db.query('UPDATE users SET solana_address = $1 WHERE address = $2', [solanaAddress, address]);
    }
}

// ========================
// Payment Functions
// ========================

async function recordPayment(txHash, userAddress, amount, type) {
    if (!dbType) await initDB();
    if (dbType === 'mongodb') {
        await Payment.updateOne(
            { tx_hash: txHash },
            { $setOnInsert: { tx_hash: txHash, user_address: userAddress, amount, type } },
            { upsert: true }
        );
    } else {
        const db = await getDB();
        await db.query(
            'INSERT INTO payments (tx_hash, user_address, amount, type) VALUES ($1, $2, $3, $4) ON CONFLICT (tx_hash) DO NOTHING',
            [txHash, userAddress, amount, type]
        );
    }
}

module.exports = {
    initDB,
    getDB,
    getUser,
    createUserIfNotExists,
    updateUserXP,
    updateUserMatchStatus,
    getLeaderboard,
    recordPayment,
    // New exports for Torque integration
    addPoints,
    updateStreak,
    resetWeeklyPoints,
    getWeeklyLeaderboard,
    linkSolanaAddress
};
