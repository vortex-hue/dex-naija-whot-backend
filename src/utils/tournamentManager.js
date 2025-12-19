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

    joinTournament(tournamentId, player) {
        const tournament = this.tournaments.get(tournamentId);

        if (!tournament) return { success: false, message: "Tournament not found" };
        if (tournament.status !== 'waiting') return { success: false, message: "Tournament already started" };
        if (tournament.players.length >= tournament.size) return { success: false, message: "Tournament full" };

        // Check if player already joined
        if (tournament.players.some(p => p.storedId === player.storedId)) {
            // Re-join logic (update socket id)
            tournament.players = tournament.players.map(p =>
                p.storedId === player.storedId ? { ...p, socketId: player.socketId } : p
            );
        } else {
            tournament.players.push(player);
        }

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

        if (!allFinished) return;

        const winners = currentRoundMatches.map(m => m.winner);

        // If only 1 winner, tournament over
        if (winners.length === 1) {
            tournament.status = 'completed';
            tournament.winner = winners[0];
            this.io.emit('tournament_update', this.getPublicTournamentState(tournament));
            return;
        }

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

    notifyMatchReady(tournament) {
        // Find active matches for current round
        const activeMatches = tournament.matches.filter(m => m.round === tournament.round && !m.winner);

        activeMatches.forEach(match => {
            if (match.p1 && match.p2) {
                // Create a unique game room ID for this match
                const gameRoomId = match.id.substring(0, 4); // Simplified room ID for standard whot game compatibility, but ideally should be unique. 
                // Actually, let's just use the match ID as the room ID, but the standard game expects a 4 char code.
                // Let's generate a temporary random 4-char code for the actual game room
                const gameRoomCode = Math.random().toString(36).substring(2, 6).toUpperCase();

                // Store mapping if needed, or just tell players where to go

                const payload = {
                    roomId: gameRoomCode,
                    matchId: match.id,
                    opponent: match.p2.name
                };

                this.io.to(match.p1.socketId).emit('tournament_match_ready', { ...payload, opponent: match.p2.name });
                this.io.to(match.p2.socketId).emit('tournament_match_ready', { ...payload, opponent: match.p1.name });
            }
        });
    }

    getPublicTournamentState(tournament) {
        return {
            id: tournament.id,
            name: tournament.name,
            size: tournament.size,
            status: tournament.status,
            currentRound: tournament.round,
            playersCount: tournament.players.length,
            matches: tournament.matches.map(m => ({
                id: m.id,
                p1: m.p1 ? { name: m.p1.name } : null,
                p2: m.p2 ? { name: m.p2.name } : null,
                winner: m.winner ? { name: m.winner.name } : null,
                round: m.round
            })),
            winner: tournament.winner ? { name: tournament.winner.name } : null
        };
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
