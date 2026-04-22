require('dotenv').config();
const { initDB, createUserIfNotExists, updateUserXP, getLeaderboard, recordPayment, getUser, updateUserMatchStatus } = require('./src/database/db');

const TEST_ADDRESS = '0xTestUser_' + Date.now(); // Unique per run
const TEST_TX = '0xTxHash_' + Date.now();

async function test() {
    console.log('--- DB Connection Test ---');
    console.log(`MONGODB_URI set: ${!!process.env.MONGODB_URI}`);
    console.log('');

    // 1. Initialize
    console.log('1. Initializing DB...');
    await initDB();
    console.log('   ✅ DB initialized\n');

    // 2. Create user
    console.log(`2. Creating test user: ${TEST_ADDRESS}`);
    const newUser = await createUserIfNotExists(TEST_ADDRESS);
    console.log('   Result:', JSON.stringify(newUser));
    if (!newUser) throw new Error('❌ createUserIfNotExists returned null');
    console.log('   ✅ User created\n');

    // 3. Get user
    console.log('3. Fetching user...');
    let user = await getUser(TEST_ADDRESS);
    console.log('   Result:', JSON.stringify(user));
    if (!user) throw new Error('❌ getUser returned null');
    if (user.xp !== 0) throw new Error(`❌ Expected xp=0, got ${user.xp}`);
    console.log('   ✅ User fetched correctly\n');

    // 4. Update XP (simulate a win)
    console.log('4. Updating XP (+10, win)...');
    await updateUserXP(TEST_ADDRESS, 10, true);
    user = await getUser(TEST_ADDRESS);
    console.log('   Result:', JSON.stringify(user));
    if (user.xp !== 10) throw new Error(`❌ Expected xp=10, got ${user.xp}`);
    if (user.wins !== 1) throw new Error(`❌ Expected wins=1, got ${user.wins}`);
    if (user.games_played !== 1) throw new Error(`❌ Expected games_played=1, got ${user.games_played}`);
    if (user.last_match_status !== 'WON') throw new Error(`❌ Expected status=WON, got ${user.last_match_status}`);
    console.log('   ✅ XP update works\n');

    // 5. Update match status
    console.log('5. Updating match status...');
    await updateUserMatchStatus(TEST_ADDRESS, 'PAID_RETRY');
    user = await getUser(TEST_ADDRESS);
    if (user.last_match_status !== 'PAID_RETRY') throw new Error(`❌ Expected status=PAID_RETRY, got ${user.last_match_status}`);
    console.log('   ✅ Match status update works\n');

    // 6. Record payment
    console.log('6. Recording payment...');
    await recordPayment(TEST_TX, TEST_ADDRESS, '0.5', 'test_fee');
    console.log('   ✅ Payment recorded\n');

    // 7. Leaderboard
    console.log('7. Getting leaderboard...');
    const lb = await getLeaderboard(5);
    console.log('   Top entries:', JSON.stringify(lb.slice(0, 3)));
    if (!Array.isArray(lb)) throw new Error('❌ Leaderboard is not an array');
    console.log('   ✅ Leaderboard works\n');

    // 8. Idempotency: creating same user again should return existing
    console.log('8. Idempotency check (create same user again)...');
    const sameUser = await createUserIfNotExists(TEST_ADDRESS);
    if (sameUser.xp !== 10) throw new Error(`❌ Expected existing user with xp=10, got ${sameUser.xp}`);
    console.log('   ✅ Idempotent\n');

    console.log('========================================');
    console.log('✅ ALL DB TESTS PASSED');
    console.log('========================================');

    process.exit(0);
}

test().catch(e => {
    console.error('\n❌ TEST FAILED:', e.message);
    process.exit(1);
});
