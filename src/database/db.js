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
                games_played: { type: Number, default: 0 },
                wins: { type: Number, default: 0 },
                last_match_status: { type: String, default: null }
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

// User Functions
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
        const users = await User.find({}, 'address xp wins games_played').sort({ xp: -1 }).limit(limit).lean();
        return users;
    } else {
        const db = await getDB();
        const res = await db.query('SELECT address, xp, wins, games_played FROM users ORDER BY xp DESC LIMIT $1', [limit]);
        return res.rows;
    }
}

// Payment Functions
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
    recordPayment
};
