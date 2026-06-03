const socket = io();
const colorMap = { 'Red': '#ff4d4d', 'Green': '#00cc00', 'Yellow': '#cccc00', 'Blue': '#4d4dff' };
const delay = ms => new Promise(res => setTimeout(res, ms));

let cachedPlayers = [];
let audioCtx = null;

let cheatActive = false;
let cheatTimer = null;
let secretRollValue = null;

const secretBtn = document.createElement('div');
secretBtn.style.cssText = 'position:fixed; bottom:0; right:0; width:60px; height:60px; z-index:9999;';
document.body.appendChild(secretBtn);

const toggleCheat = () => { cheatActive = !cheatActive; secretRollValue = null; };
const handlePressStart = () => { cheatTimer = setTimeout(toggleCheat, 2000); };
const handlePressEnd = () => clearTimeout(cheatTimer);

// Unified pointer events fix double-firing bug
secretBtn.addEventListener('pointerdown', handlePressStart);
secretBtn.addEventListener('pointerup', handlePressEnd);
secretBtn.addEventListener('pointerleave', handlePressEnd);
secretBtn.addEventListener('pointercancel', handlePressEnd);

function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
function playSound(type) {
    try {
        if (type === 'roll') {
            new Audio('dice_roll.mp3').play().catch(e => console.log('Audio blocked', e));
        } else if (type === 'move') {
            new Audio('pawn_move.mp3').play().catch(e => console.log('Audio blocked', e));
        } else if (type === 'capture') {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.type = 'sawtooth'; osc.frequency.setValueAtTime(150, audioCtx.currentTime); 
            osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime+0.3); 
            gain.gain.setValueAtTime(0.2, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime+0.3); 
            osc.start(); osc.stop(audioCtx.currentTime+0.3);
        } else if (type === 'win') {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.type = 'square'; osc.frequency.setValueAtTime(400, audioCtx.currentTime); 
            osc.frequency.setValueAtTime(600, audioCtx.currentTime+0.1); osc.frequency.setValueAtTime(800, audioCtx.currentTime+0.2); 
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime); gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime+0.4); 
            osc.start(); osc.stop(audioCtx.currentTime+0.4);
        }
    } catch(err) { console.warn(err); }
}

const UI = {
    setup: document.getElementById('setup-screen'), lobby: document.getElementById('lobby-screen'),
    game: document.getElementById('game-screen'), joinBtn: document.getElementById('joinBtn'),
    startBtn: document.getElementById('startBtn'), rollBtn: document.getElementById('rollBtn'),
    diceResult: document.getElementById('diceResult'), board: document.getElementById('board-container'),
    turnIndicator: document.getElementById('turnIndicator'), instruction: document.getElementById('instruction'),
    playersList: document.getElementById('playersList')
};

const roomInputBox = document.getElementById('roomId');
if (roomInputBox) roomInputBox.style.display = 'none';

const topBar = document.querySelector('.top-bar');
if(topBar) {
    topBar.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <h3 style="margin: 0; color: #333; font-size: 1.1rem;">Global Arena</h3>
            <div>
                <button id="leaveMatchBtn" style="width: auto; padding: 6px 12px; margin: 0; background: #e74c3c; font-size: 0.85rem; box-shadow: none;">Leave</button>
                <button id="resetRoomBtn" style="width: auto; padding: 6px 12px; margin: 0 0 0 5px; background: #34495e; font-size: 0.85rem; box-shadow: none;">Reset</button>
            </div>
        </div>
    `;
    
    document.getElementById('leaveMatchBtn').addEventListener('click', () => {
        if(confirm("Abandon this match?")) {
            socket.emit('leaveRoom');
            UI.game.style.display = 'none'; UI.setup.style.display = 'block'; 
        }
    });

    document.getElementById('resetRoomBtn').addEventListener('click', () => {
        if(confirm("Abandon current match and reset the Arena for everyone?")) {
            socket.emit('resetGame');
        }
    });
}

const leaveLobbyBtn = document.createElement('button');
leaveLobbyBtn.innerText = '← Leave Arena';
leaveLobbyBtn.style.cssText = 'background-color: #e74c3c; margin-top: 15px; width: 100%; padding: 12px; border: none; border-radius: 6px; color: white; font-weight: bold; cursor: pointer;';
leaveLobbyBtn.onclick = () => {
    socket.emit('leaveRoom');
    UI.lobby.style.display = 'none'; UI.setup.style.display = 'block'; 
};
const lobbyCard = UI.lobby.querySelector('.card') || UI.lobby;
lobbyCard.appendChild(leaveLobbyBtn);


let myId = '', myColor = null, isMyTurn = false, hasRolled = false, lastRollVal = 0;
let tokensCreated = false, autoMoveTimeout = null;

const mainPathCoords = [
    [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],[1,8],[2,8],[3,8],
    [4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],[8,13],[8,12],[8,11],[8,10],
    [8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],
    [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]
];
const homePaths = {
    'Red': [[7,1],[7,2],[7,3],[7,4],[7,5],[7,7]], 'Green': [[1,7],[2,7],[3,7],[4,7],[5,7],[7,7]],
    'Yellow': [[7,13],[7,12],[7,11],[7,10],[7,9],[7,7]], 'Blue': [[13,7],[12,7],[11,7],[10,7],[9,7],[7,7]]
};
const baseVisualPositions = {
    'Red': [{l: 14, t: 14}, {l: 26, t: 14}, {l: 14, t: 26}, {l: 26, t: 26}],
    'Green': [{l: 74, t: 14}, {l: 86, t: 14}, {l: 74, t: 26}, {l: 86, t: 26}],
    'Yellow': [{l: 74, t: 74}, {l: 86, t: 74}, {l: 74, t: 86}, {l: 86, t: 86}],
    'Blue': [{l: 14, t: 74}, {l: 26, t: 74}, {l: 14, t: 86}, {l: 26, t: 86}]
};

function getAbsolutePosition(color, relPos) {
    if (relPos < 0 || relPos > 50) return -1;
    const offsets = { 'Red': 0, 'Green': 13, 'Yellow': 26, 'Blue': 39 };
    return (relPos + offsets[color]) % 52;
}

function isValidMoveClient(boardState, color, tokenIndex, roll) {
    const currentPos = boardState[color][tokenIndex];
    if (currentPos === -1) return roll === 6;
    const newPos = currentPos + roll;
    if (newPos > 56) return false;

    // DELETE THE FOR LOOP THAT WAS HERE

    return true;
}

function initBoardGrid() {
    UI.board.innerHTML = '';
    for (let r = 0; r < 15; r++) {
        for (let c = 0; c < 15; c++) {
            const cell = document.createElement('div'); cell.classList.add('cell');
            cell.dataset.r = r; cell.dataset.c = c; 

            if (c === 7 && r > 0 && r < 7) cell.classList.add('home-green');
            if (r === 7 && c > 0 && c < 7) cell.classList.add('home-red');
            if (c === 7 && r > 7 && r < 14) cell.classList.add('home-blue');
            if (r === 7 && c > 7 && c < 14) cell.classList.add('home-yellow');
            if (r === 6 && c === 1) cell.classList.add('start-red');
            if (r === 1 && c === 8) cell.classList.add('start-green');
            if (r === 8 && c === 13) cell.classList.add('start-yellow');
            if (r === 13 && c === 6) cell.classList.add('start-blue');
            
            const safeCoords = ['6,1', '2,6', '1,8', '6,12', '8,13', '12,8', '13,6', '8,2'];
            if (safeCoords.includes(`${r},${c}`)) cell.classList.add('safe-zone');
            UI.board.appendChild(cell);
        }
    }

    const bases = [
        { id: 'base-red', class: 'base-red', color: 'Red' }, { id: 'base-green', class: 'base-green', color: 'Green' },
        { id: 'base-yellow', class: 'base-yellow', color: 'Yellow' }, { id: 'base-blue', class: 'base-blue', color: 'Blue' }
    ];

    bases.forEach(b => {
        const baseEl = document.createElement('div'); baseEl.className = `base-overlay ${b.class}`; baseEl.id = b.id;
        const inner = document.createElement('div'); inner.className = 'base-inner'; baseEl.appendChild(inner);
        UI.board.appendChild(baseEl);
    });

    const centerEl = document.createElement('div'); centerEl.className = 'center-overlay'; UI.board.appendChild(centerEl);
}
initBoardGrid();

UI.board.addEventListener('click', (e) => {
    if (!cheatActive || !isMyTurn || hasRolled) return;
    
    let r, c;
    if (e.target.classList.contains('cell')) {
        r = parseInt(e.target.dataset.r); c = parseInt(e.target.dataset.c);
    } else {
        const rect = UI.board.getBoundingClientRect();
        const bw = 3; const w = rect.width - 2 * bw; const h = rect.height - 2 * bw;
        c = Math.floor((e.clientX - rect.left - bw) / (w / 15));
        r = Math.floor((e.clientY - rect.top - bw) / (h / 15));
    }

    const offset = { 'Red': 0, 'Green': 13, 'Yellow': 26, 'Blue': 39 }[myColor];
    for (let n = 1; n <= 6; n++) {
        let checkPos = (offset + n) % 52;
        if (mainPathCoords[checkPos][0] === r && mainPathCoords[checkPos][1] === c) {
            secretRollValue = n; return; 
        }
    }
});

UI.diceResult.innerHTML = '<span class="dice-icon">🎲</span><span class="dice-text"></span>';
socket.on('connect', () => myId = socket.id);

UI.joinBtn.addEventListener('click', () => {
    initAudio(); if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    const name = document.getElementById('playerName').value;
    if (name) { 
        socket.emit('joinRoom', name); 
    }
});

function getMyColorName(colorStr) { return `<strong style="color:${colorMap[colorStr]}">${colorStr}</strong>`; }

function updateTurnIndicators(activeId, players) {
    document.querySelectorAll('.base-overlay').forEach(el => el.classList.remove('active-base'));
    const activePlayer = players.find(p => p.id === activeId);
    if(activePlayer) {
        const baseEl = document.getElementById(`base-${activePlayer.color.toLowerCase()}`);
        if(baseEl) baseEl.classList.add('active-base');
    }
}

function updatePlayerNametags(players, winners = []) {
    document.querySelectorAll('.player-nametag').forEach(el => el.remove());
    players.forEach(p => {
        const baseId = `base-${p.color.toLowerCase()}`;
        const baseEl = document.getElementById(baseId);
        if (baseEl) {
            const tag = document.createElement('div'); tag.className = 'player-nametag';
            tag.innerText = p.name;
            if (p.id === myId) { tag.style.border = '2px solid #0066cc'; tag.innerText += ' (You)'; }
            // Check winners array via color instead of socket ID
            if (winners && winners.includes(p.color)) tag.innerText += ' 👑'; 
            baseEl.appendChild(tag);
        }
    });
}

// Keep local roster synchronized with rejoin events
socket.on('playersUpdated', (players) => {
    cachedPlayers = players;
});

socket.on('roomUpdate', (game) => {
    UI.setup.style.display = 'none'; 
    UI.game.style.display = 'none'; 
    UI.lobby.style.display = 'block';
    
    UI.playersList.innerHTML = '';
    
    game.players.forEach(p => {
        if (p.id === myId) myColor = p.color;
        const li = document.createElement('li'); li.innerText = `${p.name} (${p.color})`;
        li.style.backgroundColor = colorMap[p.color]; li.style.color = 'white'; UI.playersList.appendChild(li);
    });
    cachedPlayers = game.players; 
    updatePlayerNametags(game.players, game.winners);
    if (game.players.length >= 2 && game.players[0].id === myId) UI.startBtn.style.display = 'block';
    else UI.startBtn.style.display = 'none';
});

socket.on('rejoinGame', (data) => {
    UI.setup.style.display = 'none'; UI.lobby.style.display = 'none'; UI.game.style.display = 'flex';
    myColor = data.color; myId = socket.id; 
    
    cachedPlayers = data.players; 
    updatePlayerNametags(data.players, data.winners);
    updateTurnIndicators(data.activePlayerId, data.players);
    renderTokens(data.boardState);
    document.querySelectorAll('.token').forEach(el => el.classList.remove('can-move'));
    
    isMyTurn = (data.activePlayerId === myId);
    UI.turnIndicator.style.backgroundColor = isMyTurn ? '#d4edda' : '#e8f4fd';
    UI.turnIndicator.style.color = isMyTurn ? '#155724' : '#0066cc';
    
    if (isMyTurn) {
        UI.turnIndicator.innerHTML = `Your Turn! You are ${getMyColorName(myColor)}`;
        if (data.waitingForMove) {
            hasRolled = true; lastRollVal = data.lastRoll;
            UI.diceResult.innerHTML = `<span class="dice-icon">🎲</span><span class="dice-text">${lastRollVal}</span>`;
            UI.instruction.innerText = "Select a token to move"; UI.rollBtn.disabled = true;
            checkValidMovesOrPass(data.boardState); 
        } else {
            hasRolled = false; UI.instruction.innerText = "Roll the dice"; UI.rollBtn.disabled = false;
        }
    } else {
        hasRolled = false; 
        const oppColorText = `<strong style="color:${colorMap[data.activePlayerColor] || '#333'}">${data.activePlayerName}</strong>`;
        UI.turnIndicator.innerHTML = `${oppColorText}'s Turn! You are ${getMyColorName(myColor)}`;
        UI.instruction.innerText = "Waiting for them to roll"; UI.rollBtn.disabled = true;
    }
});

UI.startBtn.addEventListener('click', () => socket.emit('startGame'));

socket.on('gameStarted', (game) => { 
    UI.lobby.style.display = 'none'; UI.game.style.display = 'flex'; 
    if (game && game.players) {
        cachedPlayers = game.players; 
        updatePlayerNametags(cachedPlayers, game.winners || []);
    }
});

socket.on('nextTurn', (data) => {
    document.querySelectorAll('.token').forEach(el => el.classList.remove('can-move'));
    isMyTurn = (data.activePlayerId === myId); hasRolled = false;
    
    updatePlayerNametags(cachedPlayers, data.winners || []); 
    updateTurnIndicators(data.activePlayerId, cachedPlayers); 
    
    renderTokens(data.boardState);

    UI.turnIndicator.style.backgroundColor = isMyTurn ? '#d4edda' : '#e8f4fd';
    UI.turnIndicator.style.color = isMyTurn ? '#155724' : '#0066cc';

    if (isMyTurn) {
        UI.turnIndicator.innerHTML = `Your Turn! You are ${getMyColorName(myColor)}`;
        UI.instruction.innerText = "Roll the dice"; UI.rollBtn.disabled = false;
    } else {
        const oppColorText = `<strong style="color:${colorMap[data.activePlayerColor] || '#333'}">${data.activePlayerName}</strong>`;
        UI.turnIndicator.innerHTML = `${oppColorText}'s Turn! You are ${getMyColorName(myColor)}`;
        UI.instruction.innerText = "Waiting for them to roll"; UI.rollBtn.disabled = true;
    }
});

socket.on('extraTurn', (playerId) => {
    isMyTurn = (playerId === myId); hasRolled = false;
    if (isMyTurn) {
        UI.turnIndicator.innerHTML = `Bonus Turn! You are ${getMyColorName(myColor)}`;
        UI.turnIndicator.style.backgroundColor = '#fff3cd'; UI.turnIndicator.style.color = '#856404';
        UI.instruction.innerText = "You get another roll!"; UI.rollBtn.disabled = false;
    }
});

UI.rollBtn.addEventListener('click', () => {
    socket.emit('rollDice', secretRollValue);
    UI.rollBtn.disabled = true;
    secretRollValue = null; 
});

socket.on('diceRolling', () => {
    playSound('roll');
    document.querySelector('.dice-icon').classList.add('rolling');
    document.querySelector('.dice-text').innerText = '';
});

socket.on('diceRolled', (data) => {
    document.querySelector('.dice-icon').classList.remove('rolling');
    UI.diceResult.innerHTML = `<span class="dice-icon">🎲</span><span class="dice-text">${data.value}</span>`;
    
    if (data.player === myId) {
        if (data.isThreeSixes) {
            UI.instruction.innerText = "Three 6s! Turn forfeited."; UI.turnIndicator.innerText = "Oops!"; hasRolled = false; 
        } else if (!data.hasValidMoves) {
            UI.instruction.innerText = "No legal moves. Passing turn..."; hasRolled = false;
        } else {
            hasRolled = true; lastRollVal = data.value;
            UI.instruction.innerText = "Select a token to move"; checkValidMovesOrPass();
        }
    }
});

socket.on('animateMove', async ({ color, tokenIndex, path }) => {
    const el = document.getElementById(`token-${color}-${tokenIndex}`);
    if (!el) return;
    
    el.style.zIndex = 100;
    
    for (let i = 0; i < path.length; i++) {
        const pos = path[i];
        playSound('move');
        
        let r, c;
        if (pos >= 0 && pos <= 50) {
            const absPos = getAbsolutePosition(color, pos);
            [r, c] = mainPathCoords[absPos];
        } else if (pos >= 51 && pos <= 56) {
            [r, c] = homePaths[color][pos - 51];
        }
        
        if (r !== undefined && c !== undefined) {
            let baseLeft = `calc(${c} * (100% / 15) + (100% / 30))`;
            let baseTop = `calc(${r} * (100% / 15) + (100% / 30))`;
            el.style.left = baseLeft;
            el.style.top = baseTop;
            el.style.transform = `translate3d(-50%, -50%, 0) scale(1.2)`; 
        }
        await delay(300); 
    }
});

socket.on('tokenCaptured', (data) => { playSound('capture'); });
socket.on('tokenHome', (data) => { playSound('win'); });
socket.on('playerFinished', (name) => { alert(`${name} got all pieces home!`); playSound('win'); });

socket.on('gameFullyOver', (winners) => { 
    alert('Match Over! The arena will now reset.'); 
    location.reload(); 
});

socket.on('arenaReset', () => { 
    alert('The Arena was manually reset! All data, players, and history have been wiped.'); 
    location.reload(); 
});

socket.on('boardUpdated', (boardState) => { renderTokens(boardState); });

function checkValidMovesOrPass(providedState) {
    document.querySelectorAll('.token').forEach(el => el.classList.remove('can-move'));
    const tokens = document.querySelectorAll(`.token-${myColor.toLowerCase()}`);
    let validTokenIndexes = [];
    
    tokens.forEach((el) => {
        const idx = parseInt(el.dataset.index);
        let mockState = {};
        if (providedState) mockState = providedState;
        else {
            ['Red', 'Green', 'Yellow', 'Blue'].forEach(c => {
                mockState[c] = [0,1,2,3].map(i => {
                    const domToken = document.getElementById(`token-${c}-${i}`);
                    return domToken ? parseInt(domToken.dataset.pos) : -1;
                });
            });
        }

        if (isValidMoveClient(mockState, myColor, idx, lastRollVal)) {
            validTokenIndexes.push(idx); el.classList.add('can-move'); 
        }
    });

    if (validTokenIndexes.length === 1) {
        UI.instruction.innerText = "Auto-moving...";
        autoMoveTimeout = setTimeout(() => {
            if (isMyTurn && hasRolled) {
                hasRolled = false; 
                document.querySelectorAll('.token').forEach(el => el.classList.remove('can-move'));
                socket.emit('moveToken', validTokenIndexes[0]);
            }
        }, 600); 
    }
}

function renderTokens(boardState) {
    if (!tokensCreated) {
        for (const color of ['Red', 'Green', 'Yellow', 'Blue']) {
            for (let i = 0; i < 4; i++) {
                const tokenEl = document.createElement('div');
                tokenEl.id = `token-${color}-${i}`;
                tokenEl.className = `token token-${color.toLowerCase()}`;
                tokenEl.dataset.index = i;
                
                tokenEl.onclick = () => {
                    if (isMyTurn && hasRolled && color === myColor && tokenEl.classList.contains('can-move')) {
                        clearTimeout(autoMoveTimeout); hasRolled = false; 
                        document.querySelectorAll('.token').forEach(el => el.classList.remove('can-move'));
                        socket.emit('moveToken', i);
                    }
                };
                UI.board.appendChild(tokenEl);
            }
        }
        tokensCreated = true;
    }

    document.querySelectorAll('.base-tick').forEach(el => el.remove());

    let cellGroups = {};

    for (const [color, positions] of Object.entries(boardState)) {
        positions.forEach((pos, idx) => {
            let r, c;
            
            if (pos === -1) {
                const el = document.getElementById(`token-${color}-${idx}`);
                el.dataset.pos = pos;
                let bp = baseVisualPositions[color][idx];
                el.style.left = `${bp.l}%`; el.style.top = `${bp.t}%`;
                el.style.transform = `translate3d(-50%, -50%, 0) scale(1.15)`; 
                el.style.zIndex = 15; 
                return;
            }

            if (pos >= 0 && pos <= 50) {
                const absPos = getAbsolutePosition(color, pos);
                [r, c] = mainPathCoords[absPos];
            } else if (pos >= 51 && pos <= 56) {
                [r, c] = homePaths[color][pos - 51];
            }

            if (r === undefined) return;
            
            const key = pos === 56 ? `home-${color}` : `${r},${c}`;
            if (!cellGroups[key]) cellGroups[key] = [];
            cellGroups[key].push({ color, idx, r, c, pos });
        });
    }

    for (let key in cellGroups) {
        let tokensInCell = cellGroups[key];
        let count = tokensInCell.length;

        tokensInCell.forEach((tokenData, overlapIndex) => {
            const el = document.getElementById(`token-${tokenData.color}-${tokenData.idx}`);
            el.dataset.pos = tokenData.pos;
            
            let baseLeft = `calc(${tokenData.c} * (100% / 15) + (100% / 30))`;
            let baseTop = `calc(${tokenData.r} * (100% / 15) + (100% / 30))`;
            let scale = 1, offsetX = 0, offsetY = 0;

            if (tokenData.pos === 56) {
                if (tokenData.color === 'Red') offsetX = -20;
                else if (tokenData.color === 'Green') offsetY = -20;
                else if (tokenData.color === 'Yellow') offsetX = 20;
                else if (tokenData.color === 'Blue') offsetY = 20;
                
                if (count > 1) {
                    offsetX += (overlapIndex % 2 === 0 ? -5 : 5);
                    offsetY += (Math.floor(overlapIndex / 2) === 0 ? -5 : 5);
                }
                scale = 0.6; 

                const tick = document.createElement('div');
                tick.className = 'base-tick';
                tick.innerHTML = '✔';
                let bp = baseVisualPositions[tokenData.color][tokenData.idx];
                tick.style.left = `${bp.l}%`;
                tick.style.top = `${bp.t}%`;
                UI.board.appendChild(tick);

            } else if (count === 2) {
                scale = 0.8; offsetX = overlapIndex === 0 ? -10 : 10;
            } else if (count === 3) {
                scale = 0.7; offsetX = overlapIndex === 0 ? 0 : (overlapIndex === 1 ? -12 : 12);
                offsetY = overlapIndex === 0 ? -10 : 10;
            } else if (count >= 4) {
                let gridSize = Math.ceil(Math.sqrt(count));
                scale = Math.max(0.35, 1.25 / gridSize);
                let row = Math.floor(overlapIndex / gridSize);
                let col = overlapIndex % gridSize;
                let cellBounds = 24; 
                let spacing = cellBounds / (gridSize - 1 || 1);
                offsetX = -(cellBounds / 2) + col * spacing;
                offsetY = -(cellBounds / 2) + row * spacing;
            }

            el.style.left = `calc(${baseLeft} + ${offsetX}px)`;
            el.style.top = `calc(${baseTop} + ${offsetY}px)`;
            el.style.transform = `translate3d(-50%, -50%, 0) scale(${scale})`;
            el.style.zIndex = 30 + overlapIndex;
        });
    }
}

socket.on('error', msg => alert(msg));