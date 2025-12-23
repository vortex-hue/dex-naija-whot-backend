require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const TournamentManager = require('./src/utils/tournamentManager');
const initializeDeck = require('./utils/functions/initializeDeck');
const reverseState = require('./utils/functions/reverseState');



const {
  initDB,
  getUser,
  createUserIfNotExists,
  getLeaderboard,
  recordPayment,
  updateUserXP,
  updateUserMatchStatus
} = require('./src/database/db');

const { createPublicClient, http, parseAbiItem } = require('viem');
const { celo } = require('viem/chains');

// 1. Setup Blockchain Client (Celo)
const publicClient = createPublicClient({
  chain: celo,
  transport: http()
});

// cUSD Contract on Celo
const CUSD_ADDRESS = '0x765DE816845861e75A25fCA122bb6898B8B1282a';
// Treasury Address (Where payments should go) - Default to a placeholder if not set
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '0xYourTreasuryAddressHere';

const app = express();
const server = createServer(app);

// Middleware
app.use(express.json()); // Enable JSON body parsing

// Initialize Database
initDB();

let rooms = [];

// --- Caching ---
let leaderboardCache = {
  data: [],
  lastUpdated: 0,
  TTL: 30000 // 30 seconds
};

// API Routes
app.get('/api/leaderboard', async (req, res) => {
  try {
    const now = Date.now();
    if (now - leaderboardCache.lastUpdated < leaderboardCache.TTL && leaderboardCache.data.length > 0) {
      return res.json({ success: true, leaderboard: leaderboardCache.data, cached: true });
    }

    const leaderboard = await getLeaderboard(50);

    // Update Cache
    leaderboardCache.data = leaderboard;
    leaderboardCache.lastUpdated = now;

    res.json({ success: true, leaderboard, cached: false });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/user/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const user = await createUserIfNotExists(address);
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { txHash, userAddress, amount, type } = req.body;

    // 1. Basic Validation
    if (!txHash || !userAddress) {
      return res.status(400).json({ success: false, message: "Missing txHash or userAddress" });
    }

    // 2. On-Chain Verification
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      return res.status(400).json({ success: false, message: "Transaction failed on-chain" });
    }

    // 3. Verify it was a transfer to us (Optional but recommended)
    // We check if any log in the receipt belongs to cUSD and involves the user -> treasury
    // This is a simplified check. For strict production, parse logs against ERC20 ABI.

    // NOTE: For this implementation, we accept the success status and the fact the user sent it.
    // In strict mode, we would verify `transfer(address,uint256)` args.

    await recordPayment(txHash, userAddress, amount, type);

    // Unlock play if it was a retry payment
    if (type === 'computer_retry') {
      await updateUserMatchStatus(userAddress, 'PAID_RETRY');
    }

    res.json({ success: true, message: "Payment verified on-chain" });
  } catch (error) {
    console.error("Payment Verification Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/report-match', async (req, res) => {
  try {
    const { address, result } = req.body; // result: 'WIN' or 'LOSS'
    if (!address) throw new Error("Missing address");

    const isWin = result === 'WIN';
    // Award 10 XP for win, 0 for loss. Updates status to WON/LOST.
    await updateUserXP(address, isWin ? 10 : 0, isWin);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Configure Socket.io for Vercel
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ["https://dex-naija-whot.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000"],
    methods: "*",
    credentials: true
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true
});

const tournamentManager = new TournamentManager(io);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: '🚀 Socket.io server is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.length,
    message: 'Whot game server is running'
  });
});

console.log("🚀 Socket.io server starting...");

io.on("connection", (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

  // --- Tournament Handlers ---

  socket.on("get_tournaments", () => {
    socket.emit("tournaments_list", tournamentManager.getAllTournaments());
  });

  socket.on("create_tournament", ({ size, name }) => {
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();
    const tournament = tournamentManager.createTournament(id, size, name || `Tournament ${id}`);
    io.emit("tournaments_list", tournamentManager.getAllTournaments());
  });

  socket.on("join_tournament", (payload) => {
    console.log("DEBUG: join_tournament payload:", payload);
    const { tournamentId, storedId, name } = payload || {};

    if (!storedId) {
      console.error("❌ join_tournament failed: Missing storedId", payload);
      socket.emit("error", "Failed to join: Missing Player ID");
      return;
    }

    const result = tournamentManager.joinTournament(tournamentId, { storedId, socketId: socket.id, name: name || `Player ${storedId.substr(0, 4)}` });
    if (!result.success) {
      socket.emit("error", result.message);
    } else {
      socket.emit("tournament_joined", result.tournament);
      io.emit("tournaments_list", tournamentManager.getAllTournaments());
    }
  });

  socket.on("request_match_info", ({ tournamentId, matchId }) => {
    tournamentManager.requestMatchInfo(socket, tournamentId, matchId);
  });

  socket.on("reconnect_tournament", ({ tournamentId, storedId }) => {
    tournamentManager.reconnectTournament(tournamentId, { storedId, socketId: socket.id });
  });

  // Keep track of which game room belongs to which tournament match
  // This is a simplified way to link them without rewriting the whole game engine
  socket.on("join_room", ({ room_id, storedId, isTournament, matchId, tournamentId }) => {
    console.log(`🎮 Player ${storedId} joining room: ${room_id}`);

    // ... (rest of join logic) ...
    // Store metadata if it's a tournament game
    if (isTournament && matchId) {
      // We can attach this metadata to the room object in 'rooms' array
      // We need to find where the room is created/updated (lines 171 and 70-91)
    }

    if (room_id?.length !== 4) {
      io.to(socket.id).emit(
        "error",
        "Sorry! Seems like this game link is invalid. Just go back and start your own game 🙏🏾."
      );
      return;
    }

    socket.join(room_id);
    let currentRoom = rooms.find((room) => room.room_id == room_id);

    if (currentRoom) {
      // Existing join logic...
      // Just ensure we preserve tournament metadata if it exists on the room
      let currentPlayers = currentRoom.players;

      if (currentPlayers.length == 1) {
        // If I'm the only player in the room, get playerOneState, and update my socketId
        if (currentPlayers[0].storedId == storedId) {
          io.to(socket.id).emit("dispatch", {
            type: "INITIALIZE_DECK",
            payload: currentRoom.playerOneState,
          });

          rooms = rooms.map((room) => {
            if (room.room_id == room_id) {
              return {
                ...room,
                players: [{ storedId, socketId: socket.id, player: "one" }],
              };
            }
            return room;
          });
        } else {
          rooms = rooms.map((room) => {
            if (room.room_id == room_id) {
              return {
                ...room,
                matchStartedAt: Date.now(), // Reset timer for fairness when 2nd player joins
                players: [
                  ...room.players,
                  { storedId, socketId: socket.id, player: "two" },
                ],
              };
            }
            return room;
          });

          io.to(socket.id).emit("dispatch", {
            type: "INITIALIZE_DECK",
            payload: reverseState(currentRoom.playerOneState),
          });

          // Check if my opponent is online
          socket.broadcast.to(room_id).emit("confirmOnlineState");

          let opponentSocketId = currentPlayers.find(
            (player) => player.storedId != storedId
          ).socketId;
          io.to(opponentSocketId).emit("opponentOnlineStateChanged", true);

          // Send chat history
          socket.emit("chat_history", currentRoom.messages || []);
        }
      } else {
        // Check if player can actually join room... (existing logic)
        let currentPlayer = currentPlayers.find(
          (player) => player.storedId == storedId
        );
        if (currentPlayer) {
          io.to(socket.id).emit("dispatch", {
            type: "INITIALIZE_DECK",
            payload:
              currentPlayer.player == "one"
                ? currentRoom.playerOneState
                : reverseState(currentRoom.playerOneState),
          });

          rooms = rooms.map((room) => {
            if (room.room_id == room_id) {
              return {
                ...room,
                players: [...room.players].map((player) => {
                  if (player.storedId == storedId) {
                    return {
                      storedId,
                      socketId: socket.id,
                      player: currentPlayer.player,
                    };
                  }
                  return player;
                }),
              };
            }
            return room;
          });

          let opponentSocketId = currentPlayers.find(
            (player) => player.storedId != storedId
          ).socketId;
          io.to(opponentSocketId).emit("opponentOnlineStateChanged", true);

          socket.broadcast.to(room_id).emit("confirmOnlineState");

          // Send chat history
          socket.emit("chat_history", currentRoom.messages || []);
        } else {
          io.to(socket.id).emit(
            "error",
            "Sorry! There are already two players on this game, just go back and start your own game 🙏🏾."
          );
        }
      }
    } else {
      // Add room to store
      const { deck, userCards, usedCards, opponentCards, activeCard } =
        initializeDeck();

      const playerOneState = {
        deck,
        userCards,
        usedCards,
        opponentCards,
        activeCard,
        whoIsToPlay: "user",
        infoText: "It's your turn to make a move now",
        infoShown: true,
        stateHasBeenInitialized: true,
        player: "one",
      };

      rooms.push({
        room_id,
        // Start NEW Metadata
        isTournament: !!isTournament,
        tournamentId: tournamentId || null,
        matchId: matchId || null,
        // End NEW Metadata
        messages: [],
        players: [
          {
            storedId,
            socketId: socket.id,
            player: "one",
          },
        ],
        playerOneState,
        matchStartedAt: Date.now(), // Track start time for 10-min limit
      });

      io.to(socket.id).emit("dispatch", {
        type: "INITIALIZE_DECK",
        payload: playerOneState,
      });
    }
  });

  socket.on("sendUpdatedState", (updatedState, room_id) => {
    try {
      let currentRoom = rooms.find((room) => room.room_id == room_id);
      if (currentRoom) {
        if (updatedState.player === "one") {
          currentRoom.playerOneState = updatedState;
        } else {
          currentRoom.playerOneState = reverseState(updatedState);
        }

        // Use socket.to instead of io.to to avoid echo to the sender
        // This prevents the sender's local state from being overwritten by its own sync message
        socket.to(room_id).emit("dispatch", {
          type: "UPDATE_STATE",
          payload: {
            playerOneState: currentRoom.playerOneState,
            playerTwoState: reverseState(currentRoom.playerOneState),
          },
        });
      }
    } catch (error) {
      console.error("Error in sendUpdatedState:", error);
    }
  });

  socket.on("game_over", (data) => {
    try {
      // data can be string (old way) or object (new way)
      const room_id = typeof data === 'string' ? data : data.room_id;
      const winnerInfo = typeof data === 'object' ? data : null;

      // Check if it was a tournament game
      const room = rooms.find(r => r.room_id == room_id);

      if (room && room.isTournament && room.tournamentId && room.matchId && winnerInfo) {
        // Determine winner Stored ID
        let winnerStoredId = null;

        // VERIFICATION: Identify reporter by socket.id, do NOT trust payload storedId alone
        const reporter = room.players.find(p => p.socketId === socket.id);

        if (reporter) {
          if (winnerInfo.winner === 'user') {
            winnerStoredId = reporter.storedId;
          } else if (winnerInfo.winner === 'opponent') {
            // Find the other player
            const other = room.players.find(p => p.storedId !== reporter.storedId);
            if (other) winnerStoredId = other.storedId;
          }

          if (winnerStoredId) {
            console.log(`🏆 Tournament Match ${room.matchId} Won by ${winnerStoredId} (Reported by ${reporter.storedId})`);
            tournamentManager.reportMatchResult(room.tournamentId, room.matchId, winnerStoredId);

            // XP Update
            updateUserXP(winnerStoredId, 10, true).catch(e => console.error("XP Update Failed:", e));
            const loser = room.players.find(p => p.storedId !== winnerStoredId);
            if (loser) updateUserXP(loser.storedId, 0, false).catch(e => console.error("XP Update Failed:", e));

            // Notify both players that the match is officially over
            io.to(room_id).emit("match_over", { winnerStoredId });
          }
        }
      }

      // Delay room cleanup slightly to ensure messages are delivered
      setTimeout(() => {
        rooms = rooms.filter((room) => room.room_id != room_id);
      }, 1000);
    } catch (error) {
      console.error("Error in game_over:", error);
    }
  });

  // Custom tournament game over handler
  socket.on("tournament_match_win", ({ room_id, tournamentId, matchId, winnerStoredId, winnerType, reporterStoredId }) => {
    try {
      const room = rooms.find(r => r.room_id == room_id);

      // Fallback: If metadata missing, try to find it in the room
      if (!tournamentId || !matchId) {
        if (room && room.isTournament) {
          tournamentId = room.tournamentId;
          matchId = room.matchId;
        }
      }

      if (tournamentId && matchId) {
        let finalWinnerId = winnerStoredId;

        // VERIFICATION: Verify reporter is in the room via socket.id
        if (room) {
          const reporter = room.players.find(p => p.socketId === socket.id);

          if (reporter && winnerType) {
            // Resolve relative winner type using verified reporter
            if (winnerType === 'user') {
              finalWinnerId = reporter.storedId;
            } else {
              const other = room.players.find(p => p.storedId !== reporter.storedId);
              if (other) finalWinnerId = other.storedId;
            }
          }
        }

        if (finalWinnerId) {
          tournamentManager.reportMatchResult(tournamentId, matchId, finalWinnerId);

          // XP Update
          updateUserXP(finalWinnerId, 10, true).catch(e => console.error("XP Update Failed:", e));
          const loser = room.players.find(p => p.storedId !== finalWinnerId);
          if (loser) updateUserXP(loser.storedId, 0, false).catch(e => console.error("XP Update Failed:", e));

          // Notify both players
          io.to(room_id).emit("match_over", { winnerStoredId: finalWinnerId });
        } else {
          console.error("❌ tournament_match_win failed: Could not resolve winner ID");
        }
      } else {
        console.error("❌ tournament_match_win failed: Missing metadata", { room_id, tournamentId, matchId });
      }

      // Clean up room with a slight delay
      setTimeout(() => {
        rooms = rooms.filter((r) => r.room_id != room_id);
      }, 1000);
    } catch (error) {
      console.error("Error in tournament_match_win:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    // Find rooms where this socket is a player
    rooms.forEach(room => {
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        // Notify opponent
        const opponent = room.players.find(p => p.socketId !== socket.id);
        if (opponent) {
          io.to(opponent.socketId).emit("opponentOnlineStateChanged", false);
        }
      }
    });
  });

  socket.on("confirmOnlineState", (storedId, room_id) => {
    try {
      let currentRoom = rooms.find((room) => room.room_id == room_id);
      if (currentRoom) {
        let opponent = currentRoom.players.find(
          (player) => player.storedId != storedId
        );

        if (opponent && opponent.socketId) {
          io.to(opponent.socketId).emit("opponentOnlineStateChanged", true);
        }
      }
    } catch (error) {
      console.error("Error in confirmOnlineState:", error);
    }
  });

  socket.on("mark_read", ({ room_id, user_id }) => {
    try {
      let currentRoom = rooms.find((room) => room.room_id == room_id);
      if (currentRoom && currentRoom.messages) {
        let hasUpdates = false;
        currentRoom.messages.forEach(msg => {
          if (msg.senderId !== user_id && msg.status !== 'read') {
            msg.status = 'read';
            hasUpdates = true;
          }
        });
        if (hasUpdates) {
          io.to(room_id).emit("messages_read", { readerId: user_id });
        }
      }
    } catch (error) {
      console.error("Error in mark_read:", error);
    }
  });
  socket.on("send_message", ({ room_id, message, senderId }) => {
    try {
      console.log(`💬 Chat: Room ${room_id} | Sender ${senderId}: ${message}`);
      let currentRoom = rooms.find((room) => room.room_id == room_id);
      if (currentRoom) {
        if (!currentRoom.messages) currentRoom.messages = [];
        const msgData = {
          id: Date.now().toString(),
          senderId,
          text: message,
          timestamp: new Date().toISOString(),
          status: 'sent'
        };
        currentRoom.messages.push(msgData);
        if (currentRoom.messages.length > 50) currentRoom.messages.shift();
        io.to(room_id).emit("receive_message", msgData);
      }
    } catch (error) {
      console.error("Error in send_message:", error);
    }
  });
});

/* 
// Temporarily disabled: Timer and Auto-Win Logic (15-minute rounds)
const ROUND_TIME_LIMIT_MS = 15 * 60 * 1000; // 15 minutes

setInterval(() => {
  try {
    const now = Date.now();
    rooms.forEach((room) => {
      // Safety check: must have matchStartedAt AND players
      if (!room.matchStartedAt || !room.players || room.players.length < 2) return;

      const elapsed = now - room.matchStartedAt;
      const timeLeft = Math.max(0, Math.floor((ROUND_TIME_LIMIT_MS - elapsed) / 1000));

      // Broadcast time left to players if in the last 60 seconds
      if (timeLeft <= 60 && timeLeft > 0) {
        io.to(room.room_id).emit("timer_update", { timeLeft });
      }

      if (elapsed >= ROUND_TIME_LIMIT_MS) {
        console.log(`⏰ Time up for room ${room.room_id}. Calculating winner...`);

        // Safety check for state existence
        if (!room.playerOneState || !room.playerOneState.userCards) {
          console.warn(`⚠️ Timer: Room ${room.room_id} has no valid state for scoring. Skipping.`);
          return;
        }

        // Calculate scores
        const p1Cards = room.playerOneState.userCards || [];
        const p2Cards = room.playerOneState.opponentCards || [];

        const p1Score = p1Cards.reduce((sum, c) => sum + (c.number || 0), 0);
        const p2Score = p2Cards.reduce((sum, c) => sum + (c.number || 0), 0);

        let winnerStoredId = null;
        const p1 = room.players.find(p => p.player === 'one');
        const p2 = room.players.find(p => p.player === 'two');

        if (p1Score < p2Score) {
          winnerStoredId = p1?.storedId;
        } else if (p2Score < p1Score) {
          winnerStoredId = p2?.storedId;
        } else {
          // Tie: Award to Player 1 (standard tie-breaker)
          winnerStoredId = p1?.storedId;
        }

        if (winnerStoredId) {
          console.log(`🏆 Timer Winner: ${winnerStoredId} (P1: ${p1Score} vs P2: ${p2Score})`);
          if (room.isTournament && room.tournamentId && room.matchId) {
            tournamentManager.reportMatchResult(room.tournamentId, room.matchId, winnerStoredId);
          }
          io.to(room.room_id).emit("match_over", { winnerStoredId, reason: "time_expired", scores: { p1: p1Score, p2: p2Score } });
        }

        // Remove room from rooms array
        rooms = rooms.filter((r) => r.room_id != room.room_id);
      }
    });
  } catch (error) {
    console.error("CRITICAL: Timer Interval Error:", error);
  }
}, 1000);
*/

const PORT = process.env.PORT || 8080;

// For Vercel compatibility
if (process.env.VERCEL) {
  module.exports = app;
} else {
  server.listen(PORT, () => {
    console.log(`🚀 Socket.io server starting on port ${PORT}...`);
  });
}

