const io = require("socket.io-client");

const SERVER_URL = "http://localhost:8080";
const NUM_PLAYERS = 4;
const sockets = [];

async function startSimulation() {
    console.log(`🤖 Starting ${NUM_PLAYERS}-Player Tournament Simulation...`);

    // 1. Connect User 1 (Creator)
    const creator = io(SERVER_URL);
    sockets.push(creator);

    await new Promise(resolve => creator.on("connect", resolve));
    console.log("✅ Creator connected");

    // 2. Creator starts a tournament
    console.log("🏆 Creating Tournament...");
    creator.emit("create_tournament", { size: NUM_PLAYERS, name: "Simulation Cup" });

    // Wait for tournament list update to get ID
    let tournamentId = null;

    await new Promise(resolve => {
        creator.on("tournaments_list", (list) => {
            const t = list.find(x => x.name === "Simulation Cup");
            if (t) {
                tournamentId = t.id;
                console.log(`✅ Tournament Created: ID=${tournamentId}`);
                // Only resolve if we found it, but might receive multiple updates
                // Removing listener to avoid leaks/logic errors in real code, but fine here
                resolve();
            }
        });
    });

    // 3. Setup Start Listener BEFORE joining
    const matchPromise = new Promise(resolve => {
        creator.on("tournament_match_ready", (data) => {
            console.log(`⚔️ Match Ready for Creator: Opponent=${data.opponent}, Room=${data.roomId}`);
            resolve(data);
        });
    });

    // 4. Connect remaining players and JOIN
    await joinPlayer(creator, "Creator", tournamentId);

    for (let i = 2; i <= NUM_PLAYERS; i++) {
        const socket = io(SERVER_URL);
        sockets.push(socket);
        await new Promise(resolve => socket.on("connect", resolve));
        await joinPlayer(socket, `Player ${i}`, tournamentId);
    }

    console.log("✅ All Players Joined");

    const matchData = await matchPromise;
    console.log("✅ Tournament Start Verified!");

    // Cleanup
    sockets.forEach(s => s.disconnect());
    console.log("🛑 Simulation Complete");
    process.exit(0);
}

function joinPlayer(socket, name, tournamentId) {
    return new Promise(resolve => {
        // Generate random ID
        const storedId = Math.random().toString(36).substring(7);
        socket.emit("join_tournament", { tournamentId, storedId, name });
        // Wait for confirmation
        const handler = (t) => {
            if (t.id === tournamentId) {
                console.log(`👉 ${name} joined successfully.`);
                socket.off("tournament_joined", handler);
                resolve();
            }
        };
        socket.on("tournament_joined", handler);
    });
}

startSimulation().catch(err => {
    console.error("❌ Simulation Failed:", err);
    process.exit(1);
});
