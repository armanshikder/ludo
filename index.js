const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/', express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const GLOBAL_ROOM = 'LUDO_MAIN_ARENA';
const games = {};

function escapeHTML(str) {
    if (!str || typeof str !== 'string') return 'Player';
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag)).trim();
}

function getAbsolutePosition(color, relPos) {
    if (relPos < 0 || relPos > 50) return -1; 
    const offsets = { 'Red': 0, 'Green': 13, 'Yellow': 26, 'Blue': 39 };
    return (relPos + offsets[color]) % 52;
}

function isValidMove(boardState, color, tokenIndex, roll) {
    const currentPos = boardState[color][tokenIndex];
    if (currentPos === -1) return roll === 6; 
    
    const newPos = currentPos + roll;
    if (newPos > 56) return false; 

    // DELETE THE FOR LOOP THAT WAS HERE

    return true;
}

function nextTurn(game) {
    game.waitingForMove = false;
    game.lastRoll = 0;
    game.consecutiveSixes = 0; 
    game.lastActivity = Date.now();
    
    let next = (game.turn + 1) % game.players.length;
    let loops = 0;
    
    // Check game.winners by player color instead of ephemeral socket ID
    while (game.winners.includes(game.players[next].color) && loops < 5) {
        next = (next + 1) % game.players.length;
        loops++;
    }
    
    if (game.winners.length >= game.players.length - 1 && game.players.length > 1) {
        game.status = 'finished';
        io.to(GLOBAL_ROOM).emit('gameFullyOver', game.winners);
        return;
    }

    game.turn = next;
    io.to(GLOBAL_ROOM).emit('nextTurn', { 
        activePlayerId: game.players[game.turn].id,
        activePlayerName: game.players[game.turn].name,
        activePlayerColor: game.players[game.turn].color,
        boardState: game.boardState,
        winners: game.winners
    });
}

io.on('connection', (socket) => {

    socket.on('leaveRoom', () => {
        socket.leave(GLOBAL_ROOM);
        const game = games[GLOBAL_ROOM];
        if (game) {
            const player = game.players.find(p => p.id === socket.id);
            if (player) {
                if (game.status === 'playing') {
                    // Push color instead of socket ID
                    if (!game.winners.includes(player.color)) game.winners.push(player.color);
                    io.to(GLOBAL_ROOM).emit('playerFinished', player.name + ' left the match!');
                    
                    // Prevent softlock by advancing turn immediately if the active player left
                    if (game.players[game.turn].id === socket.id) {
                        nextTurn(game);
                    }
                } else {
                    game.players = game.players.filter(p => p.id !== socket.id);
                    io.to(GLOBAL_ROOM).emit('roomUpdate', game);
                }
            }

            const anyActive = game.players.some(p => {
                const s = io.sockets.sockets.get(p.id);
                return s && s.connected && !game.winners.includes(p.color); 
            });
            if (!anyActive || game.players.length === 0) delete games[GLOBAL_ROOM];
        }
    });

    socket.on('joinRoom', (rawPlayerName) => {
        const playerName = escapeHTML(rawPlayerName).substring(0, 15);
        if (!playerName) return socket.emit('error', 'Invalid Name');

        socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
        socket.join(GLOBAL_ROOM);
        
        if (!games[GLOBAL_ROOM]) {
            games[GLOBAL_ROOM] = { 
                players: [], turn: 0, status: 'waiting', boardState: {}, 
                consecutiveSixes: 0, winners: [], lastActivity: Date.now(),
                isRolling: false, isMoving: false, emptySince: null
            };
        }
        
        const game = games[GLOBAL_ROOM];
        game.lastActivity = Date.now();
        game.emptySince = null; 
        
        const existingPlayer = game.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
        
        if (existingPlayer) {
            const oldSocket = io.sockets.sockets.get(existingPlayer.id);
            if (oldSocket && oldSocket.connected && existingPlayer.id !== socket.id) {
                return socket.emit('error', 'Name taken by an active player!');
            }
            existingPlayer.id = socket.id;
            
            if (game.status === 'playing') {
                // Broadcast updated socket mapping to all other connected clients
                io.to(GLOBAL_ROOM).emit('playersUpdated', game.players);

                socket.emit('rejoinGame', {
                    players: game.players, boardState: game.boardState,
                    turn: game.turn, activePlayerId: game.players[game.turn].id,
                    activePlayerName: game.players[game.turn].name,
                    activePlayerColor: game.players[game.turn].color,
                    color: existingPlayer.color, waitingForMove: game.waitingForMove || false,
                    lastRoll: game.lastRoll || 0, winners: game.winners
                });
            } else {
                io.to(GLOBAL_ROOM).emit('roomUpdate', game);
            }
            return;
        }

        if (game.status !== 'waiting') return socket.emit('error', 'Game has already started! Wait for it to finish.');
        
        if (game.players.length < 4) {
            const smartColorOrder = ['Red', 'Yellow', 'Green', 'Blue'];
            const usedColors = game.players.map(p => p.color);
            const assignedColor = smartColorOrder.find(color => !usedColors.includes(color));

            game.players.push({ id: socket.id, name: playerName, color: assignedColor });
            io.to(GLOBAL_ROOM).emit('roomUpdate', game);
        } else {
            socket.emit('error', 'The Global Arena is full! (4/4 players)');
        }
    });

    socket.on('startGame', () => {
        const game = games[GLOBAL_ROOM];
        if (game && game.players.length >= 1 && game.status === 'waiting') {
            game.status = 'playing';
            game.lastActivity = Date.now();
            
            const orderMap = { 'Red': 0, 'Green': 1, 'Yellow': 2, 'Blue': 3 };
            game.players.sort((a, b) => orderMap[a.color] - orderMap[b.color]);
            
            game.turn = 0; 
            game.boardState = {
                'Red': [-1,-1,-1,-1], 'Green': [-1,-1,-1,-1], 'Yellow': [-1,-1,-1,-1], 'Blue': [-1,-1,-1,-1]
            };
            
            io.to(GLOBAL_ROOM).emit('gameStarted', game);
            io.to(GLOBAL_ROOM).emit('nextTurn', { 
                activePlayerId: game.players[game.turn].id, 
                activePlayerName: game.players[game.turn].name,
                activePlayerColor: game.players[game.turn].color,
                boardState: game.boardState, 
                winners: game.winners 
            });
        }
    });

    socket.on('rollDice', (secretRoll) => {
        const game = games[GLOBAL_ROOM];
        if (game && game.status === 'playing' && game.players[game.turn].id === socket.id && !game.waitingForMove && !game.isRolling) {
            game.isRolling = true;
            game.lastActivity = Date.now();
            io.to(GLOBAL_ROOM).emit('diceRolling');

            setTimeout(() => {
                game.isRolling = false; 
                let diceValue = Math.floor(Math.random() * 6) + 1;
                
                if (secretRoll && typeof secretRoll === 'number' && secretRoll >= 1 && secretRoll <= 6) {
                    diceValue = secretRoll;
                }
                
                game.lastRoll = diceValue;

                if (diceValue === 6) game.consecutiveSixes += 1;
                else game.consecutiveSixes = 0;

                if (game.consecutiveSixes === 3) {
                    io.to(GLOBAL_ROOM).emit('diceRolled', { player: socket.id, value: diceValue, isThreeSixes: true });
                    setTimeout(() => nextTurn(game), 1500); 
                } else {
                    game.waitingForMove = true;
                    let hasMoves = false;
                    game.boardState[game.players[game.turn].color].forEach((pos, idx) => {
                        if (isValidMove(game.boardState, game.players[game.turn].color, idx, diceValue)) hasMoves = true;
                    });

                    io.to(GLOBAL_ROOM).emit('diceRolled', { player: socket.id, value: diceValue, isThreeSixes: false, hasValidMoves: hasMoves });
                    if (!hasMoves) setTimeout(() => nextTurn(game), 1500);
                }
            }, 400); 
        }
    });

    socket.on('moveToken', (tokenIndex) => {
        const game = games[GLOBAL_ROOM];
        if (typeof tokenIndex !== 'number' || tokenIndex < 0 || tokenIndex > 3) return;
        if (!game || !game.waitingForMove || game.players[game.turn].id !== socket.id || game.isMoving) return;

        const player = game.players[game.turn];
        const color = player.color;
        const roll = game.lastRoll;
        
        if (!isValidMove(game.boardState, color, tokenIndex, roll)) return;

        game.waitingForMove = false; 
        game.isMoving = true; 
        game.lastActivity = Date.now();

        const currentPos = game.boardState[color][tokenIndex];
        let newPos = currentPos === -1 ? 0 : currentPos + roll;
        
        const path = [];
        if (currentPos === -1) path.push(0);
        else for (let i = currentPos + 1; i <= newPos; i++) path.push(i);

        io.to(GLOBAL_ROOM).emit('animateMove', { color, tokenIndex, path });
        
        const animationDelay = path.length * 300; 

        setTimeout(() => {
            game.isMoving = false; 
            let extraTurn = false;
            if (roll === 6) extraTurn = true;
            
            game.boardState[color][tokenIndex] = newPos;

            if (newPos >= 0 && newPos <= 50) {
                const absPos = getAbsolutePosition(color, newPos);
                const safeZones = [0, 8, 13, 21, 26, 34, 39, 47]; 

                if (!safeZones.includes(absPos)) {
                    Object.keys(game.boardState).forEach(otherColor => {
                        if (otherColor !== color) {
                            const enemyPiecesOnSquare = game.boardState[otherColor].filter(
                                (otherPos) => otherPos >= 0 && otherPos <= 50 && getAbsolutePosition(otherColor, otherPos) === absPos
                            ).length;

                            if (enemyPiecesOnSquare === 1) {
                                game.boardState[otherColor].forEach((otherPos, otherIdx) => {
                                    if (otherPos >= 0 && otherPos <= 50 && getAbsolutePosition(otherColor, otherPos) === absPos) {
                                        game.boardState[otherColor][otherIdx] = -1;
                                        extraTurn = true;
                                        io.to(GLOBAL_ROOM).emit('tokenCaptured', { color: otherColor });
                                    }
                                });
                            }
                        }
                    });
                }
            }

            if (newPos === 56) {
                extraTurn = true;
                io.to(GLOBAL_ROOM).emit('tokenHome', { color: color });
            }

            io.to(GLOBAL_ROOM).emit('boardUpdated', game.boardState);

            if (game.boardState[color].every(p => p === 56)) {
                // Push color instead of socket ID
                if (!game.winners.includes(color)) game.winners.push(color);
                io.to(GLOBAL_ROOM).emit('playerFinished', player.name);
                nextTurn(game);
                return;
            }

            if (extraTurn) {
                // Only grant extra turn if the player hasn't resigned/left during animation delay
                if (!game.winners.includes(color)) {
                    game.waitingForMove = false;
                    io.to(GLOBAL_ROOM).emit('extraTurn', player.id);
                } else {
                    nextTurn(game);
                }
            } else {
                nextTurn(game);
            }
            
        }, animationDelay + 100); 
    });

    socket.on('resetGame', () => {
        const game = games[GLOBAL_ROOM];
        if (game && game.players.find(p => p.id === socket.id)) {
            delete games[GLOBAL_ROOM];
            io.to(GLOBAL_ROOM).emit('arenaReset');
        }
    });

    socket.on('disconnect', () => {
        const game = games[GLOBAL_ROOM];
        if (game) {
            const player = game.players.find(p => p.id === socket.id);
            if (player) {
                if (game.status === 'waiting') {
                    game.players = game.players.filter(p => p.id !== socket.id);
                    io.to(GLOBAL_ROOM).emit('roomUpdate', game);
                }

                const anyConnected = game.players.some(p => {
                    const s = io.sockets.sockets.get(p.id);
                    return s && s.connected;
                });
                
                if (!anyConnected || game.players.length === 0) {
                    game.emptySince = Date.now();
                }
            }
        }
    });
});

setInterval(() => {
    const now = Date.now();
    const game = games[GLOBAL_ROOM];
    if (game) {
        if (game.emptySince && (now - game.emptySince > 15 * 60 * 1000)) {
            delete games[GLOBAL_ROOM];
        } else if (game.status === 'waiting' && (now - game.lastActivity > 60 * 60 * 1000)) {
            delete games[GLOBAL_ROOM];
        } else if (game.status === 'finished' && (now - game.lastActivity > 30 * 60 * 1000)) {
            delete games[GLOBAL_ROOM];
        }
    }
}, 5 * 60 * 1000); 

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Production Server running on port ${PORT}`));