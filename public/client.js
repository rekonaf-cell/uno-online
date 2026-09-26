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
let pendingSuitCardId = null;

const suitSymbols = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };
const suitNames = { spade: 'スペード', heart: 'ハート', diamond: 'ダイヤ', club: 'クラブ' };
const redSuits = ['heart', 'diamond'];

function rankLabel(rank) {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
}

function cardLabel(card) {
  if (card.type === 'joker') return 'JOKER';
  return `${suitSymbols[card.suit]}${rankLabel(card.rank)}`;
}

function cardColorClass(card) {
  if (card.type === 'joker') return 'joker';
  return redSuits.includes(card.suit) ? 'red-suit' : 'black-suit';
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

document.getElementById('nextRoundBtn').addEventListener('click', () => {
  socket.emit('startGame');
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

document.getElementById('pageOneBtn').addEventListener('click', () => {
  socket.emit('declarePageOne');
});

document.getElementById('ronBtn').addEventListener('click', () => {
  socket.emit('ron');
});

document.getElementById('dosunBtn').addEventListener('click', () => {
  socket.emit('dosun');
});

document.getElementById('rollDiceBtn').addEventListener('click', () => {
  socket.emit('rollDice');
});

document.getElementById('submitHandSizeBtn').addEventListener('click', () => {
  const size = parseInt(document.getElementById('handSizeInput').value, 10);
  if (!Number.isInteger(size) || size < 3) return showToast('3枚以上の整数を指定してください');
  socket.emit('chooseHandSize', { size });
});

document.querySelectorAll('.suit-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const suit = btn.dataset.suit;
    document.getElementById('suitModal').classList.add('hidden');
    if (pendingSuitCardId !== null) {
      socket.emit('playCard', { cardId: pendingSuitCardId, chosenSuit: suit });
      pendingSuitCardId = null;
    }
  });
});

socket.on('connect', () => {
  myId = socket.id;
});

socket.on('errorMsg', (msg) => showToast(msg));

socket.on('state', (state) => {
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
    const winKindText =
      state.lastWinType === 'ron' ? '（ロン！）' : state.lastWinType === 'dosun' ? '（ドスン！）' : '';
    document.getElementById('winText').textContent = winner
      ? `${winner.name} の勝ち！🎉${winKindText}`
      : 'ゲーム終了';

    const resultList = document.getElementById('roundResultList');
    resultList.innerHTML = '';
    if (state.lastRoundDeltas) {
      for (const p of state.players) {
        const delta = state.lastRoundDeltas[p.id];
        if (delta === undefined) continue;
        const li = document.createElement('li');
        const sign = delta > 0 ? '+' : '';
        li.textContent = `${p.name}: ${sign}${delta}点 (累計 ${p.score}点)`;
        resultList.appendChild(li);
      }
    }

    const isHost = state.hostId === myId;
    document.getElementById('nextRoundBtn').classList.toggle('hidden', !isHost);

    document.getElementById('winModal').classList.remove('hidden');
    return;
  }
  document.getElementById('winModal').classList.add('hidden');
  showScreen('game');
  renderGame(state);
}

function renderWaiting(state) {
  document.getElementById('roomCodeDisplay').textContent = state.code;

  const lobbyContent = document.getElementById('lobbyWaitContent');
  const diceContent = document.getElementById('diceWaitContent');
  const handSizeContent = document.getElementById('handSizeWaitContent');
  lobbyContent.classList.toggle('hidden', state.phase !== 'lobby');
  diceContent.classList.toggle('hidden', state.phase !== 'dice');
  handSizeContent.classList.toggle('hidden', state.phase !== 'handSize');

  if (state.phase === 'dice') {
    renderDicePhase(state);
    return;
  }
  if (state.phase === 'handSize') {
    renderHandSizePhase(state);
    return;
  }

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

function renderDicePhase(state) {
  const list = document.getElementById('diceResultList');
  list.innerHTML = '';
  for (const p of state.players) {
    const roll = state.diceRolls[p.id];
    const li = document.createElement('li');
    if (roll) {
      li.textContent = `${p.name}: 🎲${roll.d1}+${roll.d2} = ${roll.total}`;
    } else if (state.diceRollPending.includes(p.id)) {
      li.textContent = `${p.name}: 振っています…`;
    } else {
      li.textContent = `${p.name}: 対象外`;
    }
    list.appendChild(li);
  }
  const canRoll = state.canRollDice;
  document.getElementById('rollDiceBtn').classList.toggle('hidden', !canRoll);
  document.getElementById('diceHint').textContent = canRoll
    ? '親を決めるサイコロを振ってください'
    : '他のプレイヤーがサイコロを振るのを待っています…';
}

function renderHandSizePhase(state) {
  const dealer = state.players.find((p) => p.id === state.dealerId);
  const isDealer = state.dealerId === myId;
  document.getElementById('dealerNameText').textContent = dealer
    ? isDealer
      ? 'あなたが親です。配る枚数を選んでください'
      : `${dealer.name} が親です。枚数を選んでいます…`
    : '';
  document.getElementById('handSizeChooser').classList.toggle('hidden', !isDealer);
}

function renderGame(state) {
  const me = state.players.find((p) => p.id === myId);
  const others = state.players.filter((p) => p.id !== myId);

  const oppDiv = document.getElementById('opponents');
  oppDiv.innerHTML = '';
  for (const p of others) {
    const div = document.createElement('div');
    div.className = 'opponent' + (p.id === state.currentPlayerId ? ' active' : '') + (!p.connected ? ' disconnected' : '');
    const tag = p.declaredPageOne ? ' <span class="tag">📢1枚</span>' : '';
    div.innerHTML = `<div class="oname">${escapeHtml(p.name)}${tag}</div><div class="ocount">${p.cardCount}</div><div class="oscore">${p.score}点</div>`;
    oppDiv.appendChild(div);
  }

  const discardTop = document.getElementById('discardTop');
  if (state.topCard) {
    discardTop.className = 'card ' + cardColorClass(state.topCard);
    discardTop.textContent = cardLabel(state.topCard);
  }
  document.getElementById('deckCount').textContent = state.deckCount;

  const isMyTurn = state.currentPlayerId === myId;
  const turnInfo = document.getElementById('turnInfo');
  let info = '';
  if (isMyTurn) {
    info = 'あなたの番です';
  } else {
    const cp = state.players.find((p) => p.id === state.currentPlayerId);
    info = cp ? `${cp.name} の番です` : '';
  }
  info += ` / 場のマーク: ${suitSymbols[state.currentSuit] || ''}${suitNames[state.currentSuit] || ''}`;
  if (state.pendingChain) {
    info += ` / ${state.pendingChain.rank}が連続中！ 引くと${state.pendingChain.amount}枚`;
  }
  const dealer = state.players.find((p) => p.id === state.dealerId);
  if (dealer) info += ` / 親: ${dealer.name}`;
  turnInfo.textContent = info;

  document.getElementById('myName').textContent = me ? `${me.name}(あなた) / ${me.score}点` : '';

  const handDiv = document.getElementById('hand');
  handDiv.innerHTML = '';
  const hand = state.myHand || [];
  for (const card of hand) {
    const canPlay = isMyTurn && !state.pendingDraw && cardCanPlay(card, state.topCard, state.currentSuit, state.pendingChain);
    const div = document.createElement('div');
    div.className = 'card ' + cardColorClass(card) + ' ' + (canPlay ? 'playable' : 'unplayable');
    div.textContent = cardLabel(card);
    div.addEventListener('click', () => {
      if (!isMyTurn || state.pendingDraw) return showToast('今は出せません');
      if (!cardCanPlay(card, state.topCard, state.currentSuit, state.pendingChain)) return showToast('出せないカードです');
      if (card.type === 'joker' || card.rank === 8) {
        pendingSuitCardId = card.id;
        document.getElementById('suitModal').classList.remove('hidden');
      } else {
        socket.emit('playCard', { cardId: card.id });
      }
    });
    handDiv.appendChild(div);
  }

  document.getElementById('drawBtn').classList.toggle('hidden', !isMyTurn || state.pendingDraw);
  document.getElementById('endTurnBtn').classList.toggle('hidden', !isMyTurn || !state.pendingDraw);
  document.getElementById('pageOneBtn').classList.toggle('hidden', !state.canDeclarePageOne);
  document.getElementById('ronBtn').classList.toggle('hidden', !state.canRon);
  document.getElementById('dosunBtn').classList.toggle('hidden', !state.canDosun);

  const logBox = document.getElementById('logBox');
  logBox.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  logBox.scrollTop = logBox.scrollHeight;
}

function cardCanPlay(card, topCard, currentSuit, pendingChain) {
  if (pendingChain) {
    return card.rank === pendingChain.rank;
  }
  if (!topCard) return true;
  if (card.type === 'joker') return true;
  if (card.suit === currentSuit) return true;
  if (topCard.type === 'normal' && card.rank === topCard.rank) return true;
  return false;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
