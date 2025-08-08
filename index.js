const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const initializeDeck = require("./utils/functions/initializeDeck");
const reverseState = require("./utils/functions/reverseState");

const app = express();
const server = createServer(app);

let rooms = [];

// Configure Socket.io for Vercel
const io = new Server(server, {
  cors: {
    origin: ["https://dex-naija-whot.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000"],
    methods: "*",
    credentials: true
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true
});

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
  
  socket.on("join_room", ({ room_id, storedId }) => {
    console.log(`🎮 Player ${storedId} joining room: ${room_id}`);
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
        }
      } else {
        // Check if player can actually join room, after joining, update his socketId
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

          // Check if my opponent is online
          socket.broadcast.to(room_id).emit("confirmOnlineState");
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
    const playerOneState =
      updatedState.player === "one" ? updatedState : reverseState(updatedState);
    const playerTwoState = reverseState(playerOneState);
    rooms = rooms.map((room) => {
      if (room.room_id == room_id) {
        return {
          ...room,
          playerOneState,
        };
      }
      return room;
    });

    socket.broadcast.to(room_id).emit("dispatch", {
      type: "UPDATE_STATE",
      payload: {
        playerOneState,
        playerTwoState,
      },
    });
  });

  socket.on("game_over", (room_id) => {
    rooms = rooms.filter((room) => room.room_id != room_id);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    // Find the room the player disconnected from
    let currentRoom = rooms.find((room) =>
      room.players.map((player) => player.socketId).includes(socket.id)
    );
    if (currentRoom) {
      let opponentSocketId = currentRoom.players.find(
        (player) => player.socketId != socket.id
      )?.socketId;
      if (!opponentSocketId) return;
      io.to(opponentSocketId).emit("opponentOnlineStateChanged", false);
    }
  });

  socket.on("confirmOnlineState", (storedId, room_id) => {
    let currentRoom = rooms.find((room) => room.room_id == room_id);
    if (currentRoom) {
      let opponentSocketId = currentRoom.players.find(
        (player) => player.storedId != storedId
      ).socketId;
      io.to(opponentSocketId).emit("opponentOnlineStateChanged", true);
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