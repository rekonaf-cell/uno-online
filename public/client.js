const socket = io();

const screens = {
  lobby: document.getElementById('lobby'),
  waiting: document.getElementById('waiting'),
  game: document.getElementById('game'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
}

let myId = null;
let latestState = null;
let pendingWildCardId = null;

const colorNames = { red: '赤', yellow: '黄', green: '緑', blue: '青', wild: 'ワイルド' };
const typeNames = { skip: 'スキップ', reverse: 'リバース', draw2: '+2', wild: 'ワイルド', wild4: '+4' };

function cardLabel(card) {
  if (card.type === 'number') return String(card.value);
  if (card.type === 'skip') return '⦸';
  if (card.type === 'reverse') return '⟲';
  if (card.type === 'draw2') return '+2';
  if (card.type === 'wild') return 'W';
  if (card.type === 'wild4') return '+4';
  return '?';
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2500);
}

// --- ロビー ---
document.getElementById('createBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) return showToast('ニックネームを入力してください');
  socket.emit('createRoom', { name });
});

document.getElementById('joinBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const code = document.getElementById('codeInput').value.trim();
  if (!name) return showToast('ニックネームを入力してください');
  if (!code) return showToast('部屋コードを入力してください');
  socket.emit('joinRoom', { name, code });
});

document.getElementById('startBtn').addEventListener('click', () => {
  socket.emit('startGame');
});

document.getElementById('backToLobbyBtn').addEventListener('click', () => {
  socket.emit('leaveRoom');
  document.getElementById('winModal').classList.add('hidden');
  showScreen('lobby');
});

document.getElementById('drawPile').addEventListener('click', () => {
  socket.emit('drawCard');
});

document.getElementById('drawBtn').addEventListener('click', () => {
  socket.emit('drawCard');
});

document.getElementById('endTurnBtn').addEventListener('click', () => {
  socket.emit('endTurn');
});

document.querySelectorAll('.color-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const color = btn.dataset.color;
    document.getElementById('colorModal').classList.add('hidden');
    if (pendingWildCardId !== null) {
      socket.emit('playCard', { cardId: pendingWildCardId, chosenColor: color });
      pendingWildCardId = null;
    }
  });
});

socket.on('connect', () => {
  myId = socket.id;
});

socket.on('errorMsg', (msg) => showToast(msg));

socket.on('state', (state) => {
  latestState = state;
  myId = socket.id;
  render(state);
});

function render(state) {
  if (!state.started && !state.winnerId) {
    showScreen('waiting');
    renderWaiting(state);
    return;
  }
  if (state.winnerId) {
    renderGame(state);
    const winner = state.players.find((p) => p.id === state.winnerId);
    document.getElementById('winText').textContent = winner
      ? `${winner.name} の勝ち！🎉`
      : 'ゲーム終了';
    document.getElementById('winModal').classList.remove('hidden');
    return;
  }
  document.getElementById('winModal').classList.add('hidden');
  showScreen('game');
  renderGame(state);
}

function renderWaiting(state) {
  document.getElementById('roomCodeDisplay').textContent = state.code;
  const list = document.getElementById('playerList');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === state.hostId ? '(ホスト)' : '');
    list.appendChild(li);
  }
  const isHost = state.hostId === myId;
  document.getElementById('startBtn').classList.toggle('hidden', !isHost);
  document.getElementById('waitingHint').classList.toggle('hidden', isHost);
  document.getElementById('startBtn').disabled = state.players.length < 2;
}

function renderGame(state) {
  const me = state.players.find((p) => p.id === myId);
  const others = state.players.filter((p) => p.id !== myId);

  const oppDiv = document.getElementById('opponents');
  oppDiv.innerHTML = '';
  for (const p of others) {
    const div = document.createElement('div');
    div.className = 'opponent' + (p.id === state.currentPlayerId ? ' active' : '') + (!p.connected ? ' disconnected' : '');
    div.innerHTML = `<div class="oname">${escapeHtml(p.name)}</div><div class="ocount">${p.cardCount}</div>`;
    oppDiv.appendChild(div);
  }

  const discardTop = document.getElementById('discardTop');
  if (state.topCard) {
    discardTop.className = 'card ' + (state.currentColor || state.topCard.color);
    discardTop.textContent = cardLabel(state.topCard);
  }
  document.getElementById('deckCount').textContent = state.deckCount;

  const isMyTurn = state.currentPlayerId === myId;
  const turnInfo = document.getElementById('turnInfo');
  if (isMyTurn) {
    turnInfo.textContent = 'あなたの番です';
  } else {
    const cp = state.players.find((p) => p.id === state.currentPlayerId);
    turnInfo.textContent = cp ? `${cp.name} の番です` : '';
  }

  document.getElementById('myName').textContent = me ? me.name + '(あなた)' : '';

  const handDiv = document.getElementById('hand');
  handDiv.innerHTML = '';
  const hand = state.myHand || [];
  for (const card of hand) {
    const canPlay = isMyTurn && !state.pendingDraw && cardCanPlay(card, state.topCard, state.currentColor);
    const div = document.createElement('div');
    div.className = 'card ' + (card.type === 'wild' || card.type === 'wild4' ? 'wild' : card.color) + ' ' + (canPlay ? 'playable' : 'unplayable');
    div.textContent = cardLabel(card);
    div.addEventListener('click', () => {
      if (!isMyTurn || state.pendingDraw) return showToast('今は出せません');
      if (!cardCanPlay(card, state.topCard, state.currentColor)) return showToast('出せないカードです');
      if (card.type === 'wild' || card.type === 'wild4') {
        pendingWildCardId = card.id;
        document.getElementById('colorModal').classList.remove('hidden');
      } else {
        socket.emit('playCard', { cardId: card.id });
      }
    });
    handDiv.appendChild(div);
  }

  document.getElementById('drawBtn').classList.toggle('hidden', !isMyTurn || state.pendingDraw);
  document.getElementById('endTurnBtn').classList.toggle('hidden', !isMyTurn || !state.pendingDraw);

  const logBox = document.getElementById('logBox');
  logBox.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  logBox.scrollTop = logBox.scrollHeight;
}

function cardCanPlay(card, topCard, currentColor) {
  if (!topCard) return true;
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (topCard.type === 'number' && card.type === 'number') return card.value === topCard.value;
  if (topCard.type !== 'number' && card.type === topCard.type) return true;
  return false;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
