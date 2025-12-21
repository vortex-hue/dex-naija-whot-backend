class TournamentManager {
    constructor(io) {
        this.io = io;
        this.tournaments = new Map(); // id -> tournament object
    }

    createTournament(id, size, name) {
        const tournament = {
            id,
            name,
            size: parseInt(size),
            players: [],
            status: 'waiting', // waiting, active, completed
            round: 1,
            matches: [], // Array of {id, p1, p2, winner}
            winner: null
        };

        this.tournaments.set(id, tournament);
        return tournament;
    }

    reconnectTournament(tournamentId, player) {
        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return { success: false, message: "Tournament not found" };

        const existingPlayer = tournament.players.find(p => p.storedId === player.storedId);
        if (existingPlayer) {
            const updatedPlayer = { ...existingPlayer, socketId: player.socketId };

            tournament.players = tournament.players.map(p =>
                p.storedId === player.storedId ? updatedPlayer : p
            );

            // Update matches references
            tournament.matches.forEach(m => {
                if (m.p1 && m.p1.storedId === player.storedId) m.p1 = updatedPlayer;
                if (m.p2 && m.p2.storedId === player.storedId) m.p2 = updatedPlayer;
                if (m.winner && m.winner.storedId === player.storedId) m.winner = updatedPlayer;
            });

            this.io.emit('tournament_update', this.getPublicTournamentState(tournament));
            return { success: true, tournament: this.getPublicTournamentState(tournament) };
        }
        return { success: false, message: "Player not a participant" };
    }

    joinTournament(tournamentId, player) {
        const tournament = this.tournaments.get(tournamentId);

        if (!tournament) return { success: false, message: "Tournament not found" };

        if (tournament.players.some(p => p.storedId === player.storedId)) {
            console.log(`📡 Player ${player.storedId} re-joining tournament ${tournamentId}`);
            return this.reconnectTournament(tournamentId, player);
        }

        if (tournament.status !== 'waiting') return { success: false, message: "Tournament already started" };
        if (tournament.players.length >= tournament.size) return { success: false, message: "Tournament full" };

        console.log(`📡 Player ${player.storedId} joining tournament ${tournamentId}. Name: ${player.name}`);
        tournament.players.push(player);

        // Broadcast update
        this.io.emit('tournament_update', this.getPublicTournamentState(tournament));

        // Start if full
        if (tournament.players.length === tournament.size) {
            this.startTournament(tournamentId);
        }

        return { success: true, tournament: this.getPublicTournamentState(tournament) };
    }

    startTournament(tournamentId) {
        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return;

        tournament.status = 'active';

        // Create initial matches
        this.generateMatches(tournament);

        // Broadcast start
        this.io.emit('tournament_update', this.getPublicTournamentState(tournament));

        // Notify players to join their match rooms
        this.notifyMatchReady(tournament);
    }

    generateMatches(tournament) {
        const activePlayers = tournament.players; // In round 1, all players
        // Shuffle players for randomness
        // const shuffled = [...activePlayers].sort(() => 0.5 - Math.random());

        // For simplicity, taking them in order of join for now, creating pairings
        // If round > 1, we need to take winners from previous matches

        // Simple logic for Round 1:
        if (tournament.round === 1) {
            for (let i = 0; i < tournament.size; i += 2) {
                tournament.matches.push({
                    id: `${tournament.id}_r1_m${i / 2}`,
                    p1: activePlayers[i],
                    p2: i + 1 < activePlayers.length ? activePlayers[i + 1] : null, // Handle odd numbers as bye later if needed, but assuming powers of 2 for now
                    winner: null,
                    round: 1
                });
            }
        }
    }

    advanceRound(tournament) {
        // Check if all matches in current round are finished
        const currentRoundMatches = tournament.matches.filter(m => m.round === tournament.round);
        const allFinished = currentRoundMatches.every(m => m.winner !== null);

        if (!allFinished) {
            this.io.emit('tournament_update', this.getPublicTournamentState(tournament));
            return;
        }

        const winners = currentRoundMatches.map(m => m.winner).filter(w => w !== null);

        // If only 1 winner AND it's the final round based on size
        const totalRoundsNeeded = Math.log2(tournament.size);
        if (winners.length === 1 && tournament.round >= totalRoundsNeeded) {
            tournament.status = 'completed';
            tournament.winner = winners[0];
            this.io.emit('tournament_update', this.getPublicTournamentState(tournament));

            // Schedule cleanup after 10 minutes
            console.log(`🗑️ Scheduling cleanup for tournament ${tournament.id} in 10 minutes`);
            setTimeout(() => {
                if (this.tournaments.has(tournament.id)) {
                    this.tournaments.delete(tournament.id);
                    this.io.emit('tournaments_list', this.getAllTournaments()); // Refresh list for everyone
                    console.log(`🗑️ Tournament ${tournament.id} deleted`);
                }
            }, 10 * 60 * 1000);

            return;
        }

        // If we have winners but haven't reached final, advance
        tournament.round++;

        // Create new matches from winners
        for (let i = 0; i < winners.length; i += 2) {
            tournament.matches.push({
                id: `${tournament.id}_r${tournament.round}_m${i / 2}`,
                p1: winners[i],
                p2: i + 1 < winners.length ? winners[i + 1] : null,
                winner: null,
                round: tournament.round
            });
        }

        this.io.emit('tournament_update', this.getPublicTournamentState(tournament));
        this.notifyMatchReady(tournament);
    }

    reportMatchResult(tournamentId, matchId, winnerStoredId) {
        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return;

        const match = tournament.matches.find(m => m.id === matchId);
        if (!match) return;

        if (match.winner) return; // Already reported

        const winner = tournament.players.find(p => p.storedId === winnerStoredId);
        match.winner = winner;

        this.advanceRound(tournament);
    }

    requestMatchInfo(socket, tournamentId, matchId) {
        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return;

        const match = tournament.matches.find(m => m.id === matchId);
        if (!match) return;

        // Generate or retrieve room code (deterministic based on matchID for simplicity now, or regenerate)
        // Ideally we should store the generated room code in the match object to be consistent
        // For now, let's look if we can find an existing room for this match in the main rooms array? 
        // No, TournamentManager doesn't read 'rooms' array directly easily without passing it in.
        // Let's just generate a new one or hashed one.
        // Wait, if p1 is already in room X, p2 must go to room X.
        // We MUST store the room code in the match object once created.

        if (match.roomCode) {
            const payload = {
                roomId: match.roomCode,
                matchId: match.id,
                opponent: match.p1.socketId === socket.id ? match.p2.name : match.p1.name,
                tournamentId: tournament.id
            };
            socket.emit('tournament_match_ready', payload);
        } else {
            // Should have been created?
            this.notifyMatchReady(tournament);
        }
    }

    notifyMatchReady(tournament) {
        // Find active matches for current round
        const activeMatches = tournament.matches.filter(m => m.round === tournament.round && !m.winner);

        activeMatches.forEach(match => {
            if (match.p1 && match.p2) {
                // Generate room code if not exists
                if (!match.roomCode) {
                    match.roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
                }

                const payload = {
                    roomId: match.roomCode,
                    matchId: match.id,
                    opponent: match.p2.name,
                    tournamentId: tournament.id
                };

                this.io.to(match.p1.socketId).emit('tournament_match_ready', { ...payload, opponent: match.p2.name });
                this.io.to(match.p2.socketId).emit('tournament_match_ready', { ...payload, opponent: match.p1.name });
            }
        });
    }

    getPublicTournamentState(tournament) {
        const state = {
            id: tournament.id,
            name: tournament.name,
            size: tournament.size,
            status: tournament.status,
            currentRound: tournament.round,
            playersCount: tournament.players?.length || 0,
            participants: (tournament.players || []).map(p => p.storedId).filter(id => !!id),
            matches: (tournament.matches || []).map(m => ({
                id: m.id,
                p1: m.p1 ? { name: m.p1.name, storedId: m.p1.storedId } : null,
                p2: m.p2 ? { name: m.p2.name, storedId: m.p2.storedId } : null,
                winner: m.winner ? { name: m.winner.name, storedId: m.winner.storedId } : null,
                round: m.round
            })),
            winner: tournament.winner ? { name: tournament.winner.name, storedId: tournament.winner.storedId } : null
        };
        console.log(`📡 Sending state for tournament ${tournament.id} | Participants: ${state.participants.length}`);
        return state;
    }

    getAllTournaments() {
        return Array.from(this.tournaments.values()).map(t => this.getPublicTournamentState(t));
    }

    // Helper to handle game over event from the standard game logic
    handleGameOver(room_id, winner_id) {
        // This needs to link back to the match. 
        // Since the standard game logic just broadcasts 'game_over', we might need to modify it 
        // or pass the tournament match ID into the room metadata when creating it.
    }
}

module.exports = TournamentManager;
