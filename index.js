require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const TournamentManager = require('./src/utils/tournamentManager');
const initializeDeck = require('./utils/functions/initializeDeck');
const reverseState = require('./utils/functions/reverseState');



const app = express();
const server = createServer(app);

let rooms = [];

// Configure Socket.io for Vercel
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

  socket.on("join_tournament", ({ tournamentId, storedId, name }) => {
    const result = tournamentManager.joinTournament(tournamentId, { storedId, socketId: socket.id, name: name || `Player ${storedId.substr(0, 4)}` });
    if (!result.success) {
      socket.emit("error", result.message);
    } else {
      socket.emit("tournament_joined", result.tournament);
      io.emit("tournaments_list", tournamentManager.getAllTournaments());
    }
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

        io.to(room_id).emit("dispatch", {
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

        // If reporter says 'user' won, and reporter is P1, then P1 won.
        // We need to map 'user'/'opponent' to storedId
        const reporter = room.players.find(p => p.storedId === winnerInfo.reporterStoredId);

        if (reporter) {
          if (winnerInfo.winner === 'user') {
            winnerStoredId = reporter.storedId;
          } else if (winnerInfo.winner === 'opponent') {
            // Find the other player
            const other = room.players.find(p => p.storedId !== reporter.storedId);
            if (other) winnerStoredId = other.storedId;
          }

          if (winnerStoredId) {
            console.log(`🏆 Tournament Match ${room.matchId} Won by ${winnerStoredId}`);
            tournamentManager.reportMatchResult(room.tournamentId, room.matchId, winnerStoredId);
          }
        }
      }

      rooms = rooms.filter((room) => room.room_id != room_id);
    } catch (error) {
      console.error("Error in game_over:", error);
    }
  });

  // Custom tournament game over handler
  // We'll ask frontend to emit 'tournament_match_win' instead of just relying on generic game_over
  socket.on("tournament_match_win", ({ room_id, tournamentId, matchId, winnerStoredId }) => {
    try {
      tournamentManager.reportMatchResult(tournamentId, matchId, winnerStoredId);
      // Clean up room
      rooms = rooms.filter((room) => room.room_id != room_id);
    } catch (error) {
      console.error("Error in tournament_match_win:", error);
    }
  });

  socket.on("disconnect", () => {
    // ... existing disconnect logic ...
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
  }

socket.on("send_message", ({ room_id, message, senderId }) => {
    try {
      console.log(`💬 Chat: Room ${room_id} | Sender ${senderId}: ${message}`);
      let currentRoom = rooms.find((room) => room.room_id == room_id);
      if (currentRoom) {
        // Ensure messages array exists (backward compatibility)
        if (!currentRoom.messages) currentRoom.messages = [];

        const msgData = {
          id: Date.now().toString(),
          senderId,
          text: message,
          timestamp: new Date().toISOString()
        };
        currentRoom.messages.push(msgData);
        // Limit history to last 50 messages to save memory
        if (currentRoom.messages.length > 50) {
          currentRoom.messages.shift();
        }
        io.to(room_id).emit("receive_message", msgData);
        console.log(`✅ Broadcasted to ${room_id}`);
      } else {
        console.warn(`⚠️ Chat failed: Room ${room_id} not found`);
      }
    } catch (error) {
      console.error("Error in send_message:", error);
    }
  });
});

const PORT = process.env.PORT || 8080;

// For Vercel compatibility
if (process.env.VERCEL) {
  module.exports = app;
} else {
  server.listen(PORT, () => {
    console.log(`🚀 Socket.io server starting on port ${PORT}...`);
  });
}

