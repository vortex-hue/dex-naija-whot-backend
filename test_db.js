const { initDB, createUserIfNotExists, updateUserXP, getLeaderboard, recordPayment, getUser } = require('./src/database/db');

async function test() {
    await initDB();

    console.log('Creating Test User...');
    const addr = '0xTestUser123';
    await createUserIfNotExists(addr);

    console.log('Updating XP (Win)...');
    await updateUserXP(addr, 10, true);

    console.log('Getting User...');
    const user = await getUser(addr);
    console.log('User:', user);

    if (user.xp !== 10 || user.wins !== 1) throw new Error('XP/Wins update failed');
    if (user.last_match_status !== 'WON') throw new Error('Status update failed');

    console.log('Recording Payment...');
    await recordPayment('0xTxHash1', addr, '0.1', 'test_fee');

    console.log('Getting Leaderboard...');
    const lb = await getLeaderboard();
    console.log('Leaderboard:', lb);

    if (lb.length === 0) throw new Error('Leaderboard empty');

    console.log('✅ ALL DB TESTS PASSED');
}

test().catch(e => {
    console.error(e);
    process.exit(1);
});
