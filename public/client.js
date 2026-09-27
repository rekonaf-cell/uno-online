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
let pendingIsJoker = false;
let pendingChosenSuit = null;
let pendingChosenRank = null;
let raisedCardId = null; // fanned hand: card the player tapped to preview before playing

const HAND_CARD_WIDTH = 68;
const HAND_CARD_GAP = 6;
const HAND_MIN_PEEK = 36; // narrowest sliver a covered card can be overlapped down to — kept large enough to tap reliably

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
  if (card.type === 'joker') {
    // Once played, a joker carries the number/suit the player declared for
    // it; keep the rainbow joker background but show that value instead.
    return card.chosenRank ? `${suitSymbols[card.chosenSuit]}${rankLabel(card.chosenRank)}` : 'JOKER';
  }
  return `${suitSymbols[card.suit]}${rankLabel(card.rank)}`;
}

function historyCardLabel(card) {
  if (card.type === 'joker') {
    return card.chosenRank ? `${suitSymbols[card.chosenSuit]}${rankLabel(card.chosenRank)}` : 'JK';
  }
  return `${suitSymbols[card.suit]}${rankLabel(card.rank)}`;
}

function cardColorClass(card) {
  if (card.type === 'joker') return 'joker';
  return redSuits.includes(card.suit) ? 'red-suit' : 'black-suit';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors game.js's cardPointValue()/handScore(): A/3/joker=10, J/Q/K keep
// their rank, 2 contributes nothing on its own but doubles everything else.
function cardPointValue(card) {
  if (card.type === 'joker') return 10;
  if (card.rank === 1) return 10;
  if (card.rank === 3) return 10;
  if (card.rank === 2) return 0;
  return card.rank;
}

function orderForScoring(hand) {
  return [...hand.filter((c) => c.rank !== 2), ...hand.filter((c) => c.rank === 2)];
}

let scoreAnimGeneration = 0;
let lastScoreAnimSignature = null;

function burstConfetti(stage, x, y) {
  const colors = ['#f2c12e', '#e6412e', '#3a9b4c', '#2a6fdb', '#c9a227'];
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('div');
    p.className = 'anim-confetti';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.background = colors[i % colors.length];
    stage.appendChild(p);
    const angle = Math.random() * Math.PI * 2;
    const dist = 24 + Math.random() * 24;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    p.animate(
      [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 }],
      { duration: 450, easing: 'ease-out' }
    );
    setTimeout(() => p.remove(), 470);
  }
}

async function doubleBurst(stage, label) {
  const flash = document.createElement('div');
  flash.className = 'anim-double-flash';
  stage.appendChild(flash);
  const burst = document.createElement('div');
  burst.className = 'anim-double-text';
  burst.textContent = label;
  stage.appendChild(burst);
  flash.animate([{ opacity: 0 }, { opacity: 0.6, offset: 0.3 }, { opacity: 0 }], { duration: 500, easing: 'ease-out' });
  burst.animate(
    [
      { transform: 'translate(-50%,-50%) scale(0.4)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.2)', opacity: 1, offset: 0.4 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.75 },
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
    ],
    { duration: 650, easing: 'ease-out' }
  );
  await sleep(600);
  flash.remove();
  burst.remove();
}

// Plays one payer's hand counting up to their point loss, card by card —
// the 2 always lands last with a pause and a red flash/burst before it
// doubles the running total, then any extra 当たり/ドン/当たり返し
// multiplier gets its own burst at the end.
async function playScoreBreakdown(container, payerName, breakdown, gen) {
  const row = document.createElement('div');
  row.className = 'score-anim-row';
  row.innerHTML =
    `<div class="score-anim-label"><b>${escapeHtml(payerName)}</b> の支払い計算</div>` +
    `<div class="score-stage"></div>` +
    `<div class="score-anim-total"><span class="odowrap"><span class="digits"><div>0</div></span></span><span class="pt">点</span></div>`;
  container.appendChild(row);
  const stage = row.querySelector('.score-stage');
  const digits = row.querySelector('.digits');

  function pushDigit(v) {
    const d = document.createElement('div');
    d.textContent = v;
    digits.appendChild(d);
    digits.style.transform = `translateY(-${(digits.children.length - 1) * 26}px)`;
  }

  let total = 0;
  for (const card of orderForScoring(breakdown.hand)) {
    if (scoreAnimGeneration !== gen) return;
    const isTwo = card.rank === 2;
    // A beat of silence before the 2 shows up builds suspense for the
    // double — the reveal lands harder after a pause than back-to-back.
    if (isTwo) await sleep(700);
    const c = document.createElement('div');
    c.className = 'anim-card ' + cardColorClass(card) + (isTwo ? ' two' : '');
    c.textContent = cardLabel(card);
    stage.appendChild(c);
    await sleep(25);
    c.classList.add('show');
    const r = c.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    burstConfetti(stage, r.left - sr.left + r.width / 2, r.top - sr.top + r.height / 2);
    if (isTwo) {
      await doubleBurst(stage, '×2');
      const doubled = total * 2;
      for (const f of [Math.max(1, Math.round(total * 1.4)), Math.max(1, Math.round(total * 1.8)), doubled]) {
        pushDigit(f);
        await sleep(85);
      }
      total = doubled;
    } else {
      total += cardPointValue(card);
      pushDigit(total);
    }
    await sleep(380);
  }
  if (breakdown.multiplier > 1) {
    if (scoreAnimGeneration !== gen) return;
    await sleep(300);
    await doubleBurst(stage, `×${breakdown.multiplier}`);
    total *= breakdown.multiplier;
    pushDigit(total);
  }
  // Simultaneous winners each get paid this same amount separately, so the
  // payer's real total is this figure repeated once per winner.
  const payments = breakdown.payments || 1;
  if (payments > 1) {
    if (scoreAnimGeneration !== gen) return;
    await sleep(300);
    await doubleBurst(stage, `×${payments}人`);
    total *= payments;
    pushDigit(total);
  }
}

async function playAllScoreAnims(state, gen) {
  const container = document.getElementById('scoreAnims');
  container.innerHTML = '';
  if (!state.scoreBreakdown) return;
  for (const p of state.players) {
    if (scoreAnimGeneration !== gen) return;
    const breakdown = state.scoreBreakdown[p.id];
    if (!breakdown) continue;
    await playScoreBreakdown(container, p.name, breakdown, gen);
  }
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

document.getElementById('addBotBtn').addEventListener('click', () => {
  socket.emit('addBot');
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

document.getElementById('pageOneBtn').addEventListener('click', () => {
  socket.emit('declarePageOne');
});

document.getElementById('ronBtn').addEventListener('click', () => {
  socket.emit('ron');
});

document.getElementById('dosunBtn').addEventListener('click', () => {
  socket.emit('dosun');
});

document.getElementById('passBtn').addEventListener('click', () => {
  socket.emit('pass');
});

document.getElementById('ronBackBtn').addEventListener('click', () => {
  socket.emit('ronBack');
});

document.getElementById('declineRonBackBtn').addEventListener('click', () => {
  socket.emit('declineRonBack');
});

document.getElementById('rollDiceBtn').addEventListener('click', () => {
  socket.emit('rollDice');
});

document.querySelectorAll('.hand-size-btn[data-size]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('handSizeCustom').classList.add('hidden');
    socket.emit('chooseHandSize', { size: Number(btn.dataset.size) });
  });
});

document.getElementById('handSizeOtherBtn').addEventListener('click', () => {
  document.getElementById('handSizeCustom').classList.remove('hidden');
  document.getElementById('handSizeInput').focus();
});

document.getElementById('submitHandSizeBtn').addEventListener('click', () => {
  const size = parseInt(document.getElementById('handSizeInput').value, 10);
  if (!Number.isInteger(size) || size < 3) return showToast('3枚以上の整数を指定してください');
  socket.emit('chooseHandSize', { size });
});

const rankChoicesDiv = document.getElementById('rankChoices');
for (let rank = 1; rank <= 13; rank++) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rank-btn';
  btn.textContent = rankLabel(rank);
  btn.dataset.rank = rank;
  btn.addEventListener('click', () => {
    pendingChosenRank = rank;
    rankChoicesDiv.querySelectorAll('.rank-btn').forEach((b) => b.classList.toggle('selected', Number(b.dataset.rank) === rank));
    tryEmitPendingPlay();
  });
  rankChoicesDiv.appendChild(btn);
}

function resetPendingSuitModal() {
  document.getElementById('suitModal').classList.add('hidden');
  document.getElementById('rankChooser').classList.add('hidden');
  rankChoicesDiv.querySelectorAll('.rank-btn').forEach((b) => b.classList.remove('selected'));
  pendingSuitCardId = null;
  pendingIsJoker = false;
  pendingChosenSuit = null;
  pendingChosenRank = null;
}

function tryEmitPendingPlay() {
  if (pendingSuitCardId === null || pendingChosenSuit === null) return;
  if (pendingIsJoker && pendingChosenRank === null) return;
  socket.emit('playCard', {
    cardId: pendingSuitCardId,
    chosenSuit: pendingChosenSuit,
    chosenRank: pendingIsJoker ? pendingChosenRank : undefined,
  });
  resetPendingSuitModal();
}

document.querySelectorAll('.suit-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    pendingChosenSuit = btn.dataset.suit;
    tryEmitPendingPlay();
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
  // Always start from a clean slate: only the winnerIds branch below turns
  // this back on. Without this, the modal could stay stuck on screen when
  // moving from "round just ended" into the dice/hand-size phase for the
  // next round, since that transition clears winnerIds but isn't the
  // branch that explicitly hides it.
  document.getElementById('winModal').classList.add('hidden');

  const winnerIds = state.winnerIds || [];

  if (!state.started && winnerIds.length === 0) {
    showScreen('waiting');
    renderWaiting(state);
    return;
  }
  if (winnerIds.length > 0) {
    renderGame(state);
    const winners = winnerIds.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
    const winKindText =
      state.lastWinType === 'ron' ? '（当たり！）' : state.lastWinType === 'dosun' ? '（ドン！）' : '';
    const winnerNames = winners.map((w) => w.name).join('・');
    document.getElementById('winText').textContent = winnerNames
      ? `${winnerNames} の勝ち！🎉${winKindText}`
      : 'ゲーム終了';

    // Only (re)play the scoring animation once per round end — a re-render
    // triggered by something unrelated (a reconnect, a log update) while
    // the modal is still up must not restart it from scratch.
    const scoreSig = winnerIds.join(',') + '|' + state.lastWinType + '|' + JSON.stringify(state.lastRoundDeltas);
    if (scoreSig !== lastScoreAnimSignature) {
      lastScoreAnimSignature = scoreSig;
      scoreAnimGeneration += 1;
      playAllScoreAnims(state, scoreAnimGeneration);
    }

    const revealedDiv = document.getElementById('revealedHands');
    revealedDiv.innerHTML = '';
    if (state.revealedHands) {
      for (const w of winners) {
        const hand = state.revealedHands[w.id] || [];
        const row = document.createElement('div');
        row.className = 'revealed-row';
        const label = document.createElement('div');
        label.className = 'revealed-label';
        label.textContent = `${w.name} の手札`;
        row.appendChild(label);
        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'revealed-cards';
        for (const card of hand) {
          const c = document.createElement('div');
          c.className = 'mini-card ' + cardColorClass(card);
          c.textContent = cardLabel(card);
          cardsDiv.appendChild(c);
        }
        row.appendChild(cardsDiv);
        revealedDiv.appendChild(row);
      }
    }

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

  const isHost = state.hostId === myId;

  const list = document.getElementById('playerList');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = p.name + (p.id === state.hostId ? '(ホスト)' : '') + (p.isBot ? ' 🤖CPU' : '');
    li.appendChild(label);
    if (p.isBot && isHost) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '削除';
      removeBtn.className = 'small-btn';
      removeBtn.addEventListener('click', () => socket.emit('removeBot', { botId: p.id }));
      li.appendChild(removeBtn);
    }
    list.appendChild(li);
  }
  document.getElementById('addBotBtn').classList.toggle('hidden', !isHost || state.players.length >= 6);
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
  document.getElementById('handSizeCustom').classList.add('hidden');
}

function renderGame(state) {
  const me = state.players.find((p) => p.id === myId);
  const others = state.players.filter((p) => p.id !== myId);

  // Seat opponents around the top arc of the round table (bottom stays
  // clear for "you"), so turn order reads as a physical seating order.
  const seatsDiv = document.getElementById('tableSeats');
  seatsDiv.innerHTML = '';
  const seatArc = 290;
  const seatStart = 215;
  const seatStep = seatArc / (others.length + 1);
  others.forEach((p, i) => {
    const angle = (seatStart + seatStep * (i + 1)) % 360;
    const rad = (angle * Math.PI) / 180;
    const leftPct = 50 + Math.sin(rad) * 50;
    const topPct = 50 - Math.cos(rad) * 50;
    const div = document.createElement('div');
    div.className =
      'seat' +
      (p.id === state.currentPlayerId ? ' active' : '') +
      (!p.connected ? ' disconnected' : '') +
      (p.declaredPageOne ? ' page-one' : '');
    div.style.left = leftPct + '%';
    div.style.top = topPct + '%';
    const botTag = p.isBot ? ' 🤖' : '👤';
    const dealerTag = p.id === state.dealerId ? '<div class="dealer-tag">親</div>' : '';
    const tag = p.declaredPageOne ? '<div class="page-one-badge">📢</div>' : '';
    div.innerHTML =
      `<div class="seat-avatar">${botTag}${dealerTag}<div class="count-badge">${p.cardCount}</div></div>` +
      `<div class="sname">${escapeHtml(p.name)}</div>` +
      `<div class="sinfo">${p.score}点</div>${tag}`;
    seatsDiv.appendChild(div);
  });

  const dirBadge = document.getElementById('dirBadge');
  dirBadge.textContent = '↻';
  dirBadge.classList.toggle('reverse', state.direction === -1);

  const selfSeat = document.querySelector('#selfSeat .seat-avatar');
  if (selfSeat) {
    selfSeat.classList.toggle('active', state.currentPlayerId === myId);
    selfSeat.classList.toggle('page-one-self-avatar', !!(me && me.declaredPageOne));
    const existingDealerTag = selfSeat.querySelector('.dealer-tag');
    if (state.dealerId === myId && !existingDealerTag) {
      selfSeat.insertAdjacentHTML('beforeend', '<div class="dealer-tag">親</div>');
    } else if (state.dealerId !== myId && existingDealerTag) {
      existingDealerTag.remove();
    }
  }
  const selfCountBadge = document.getElementById('selfCountBadge');
  if (selfCountBadge) selfCountBadge.textContent = (state.myHand || []).length;

  document.getElementById('deckCount').textContent = state.deckCount;

  // Center of the table: the current card sits large and gold-bordered in
  // front, with up to 3 earlier discards fanned smaller behind it — the
  // "history" and "what's live now" are the same stack, just by size.
  const stackDiv = document.getElementById('historyStack');
  stackDiv.innerHTML = '';
  const HISTORY_DEPTH = 4;
  const recent = (state.discardHistory || []).slice(-HISTORY_DEPTH);
  recent.forEach((card, i) => {
    const depth = recent.length - 1 - i; // 0 = current card, higher = older
    const div = document.createElement('div');
    div.className = `hist-card depth-${depth} ` + cardColorClass(card);
    div.textContent = historyCardLabel(card);
    stackDiv.appendChild(div);
  });

  const awaitingPassFrom = state.awaitingPassFrom || [];
  const waitingForOthers = awaitingPassFrom.length > 0 || !!state.awaitingRonBack;
  const isMyTurn = state.currentPlayerId === myId && !waitingForOthers;
  const turnInfo = document.getElementById('turnInfo');
  let info = '';
  if (state.awaitingRonBack) {
    const p = state.players.find((pl) => pl.id === state.awaitingRonBack);
    info =
      state.awaitingRonBack === myId
        ? 'あなたは当たり返しできます！'
        : `${p ? p.name : ''} が当たり返しできるか確認中…`;
  } else if (waitingForOthers) {
    const names = awaitingPassFrom
      .map((id) => state.players.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => p.name)
      .join('・');
    info = `${names} の確認待ち(通す/当たり/ドン)`;
  } else if (state.currentPlayerId === myId) {
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

  const myPageOneTag = me && me.declaredPageOne ? ' 📢ページワン！' : '';
  document.getElementById('myName').textContent = me ? `${me.name}(あなた) / ${me.score}点${myPageOneTag}` : '';
  document.getElementById('myName').classList.toggle('page-one-self', !!(me && me.declaredPageOne));

  const handDiv = document.getElementById('hand');
  handDiv.innerHTML = '';
  const hand = state.myHand || [];
  if (!hand.some((c) => c.id === raisedCardId)) raisedCardId = null;

  // Fan the hand: cards overlap just enough to fit the visible width, so a
  // large hand stays scannable instead of forcing a long horizontal scroll.
  const containerWidth = handDiv.clientWidth || window.innerWidth - 32;
  const idealStep = HAND_CARD_WIDTH + HAND_CARD_GAP;
  const idealTotal = HAND_CARD_WIDTH + (hand.length - 1) * idealStep;
  let step = idealStep;
  if (hand.length > 1 && idealTotal > containerWidth) {
    step = Math.max(HAND_MIN_PEEK, (containerWidth - HAND_CARD_WIDTH) / (hand.length - 1));
  }

  hand.forEach((card, index) => {
    const canPlay = isMyTurn && cardCanPlay(card, state.topCard, state.currentSuit, state.pendingChain);
    const isRaised = card.id === raisedCardId;
    const div = document.createElement('div');
    div.className =
      'card ' + cardColorClass(card) + ' ' + (canPlay ? 'playable' : 'unplayable') + (isRaised ? ' raised' : '');
    if (index > 0) div.style.marginLeft = (step - HAND_CARD_WIDTH) + 'px';
    div.innerHTML = `<span class="corner">${historyCardLabel(card)}</span>${cardLabel(card)}`;
    div.addEventListener('click', () => {
      if (!isRaised) {
        // First tap on a fanned card just brings it forward so it can be
        // seen clearly; this works any time, even outside your turn, so
        // the hand stays browsable. Only the second tap attempts to play it.
        raisedCardId = card.id;
        renderGame(state);
        return;
      }
      if (waitingForOthers) return showToast('他のプレイヤーの確認待ちです');
      if (!isMyTurn) return showToast('今は出せません');
      if (!cardCanPlay(card, state.topCard, state.currentSuit, state.pendingChain)) return showToast('出せないカードです');
      raisedCardId = null;
      if (card.type === 'joker' || card.rank === 8) {
        pendingSuitCardId = card.id;
        pendingIsJoker = card.type === 'joker';
        pendingChosenSuit = null;
        // Answering a 2/3 chain, the joker IS that 2/3 — its number isn't a
        // free choice, so skip the rank chooser and lock it in already.
        const lockedRank = pendingIsJoker && state.pendingChain ? state.pendingChain.rank : null;
        pendingChosenRank = lockedRank;
        document.getElementById('suitModal').classList.remove('hidden');
        document.getElementById('rankChooser').classList.toggle('hidden', !pendingIsJoker || lockedRank !== null);
      } else {
        socket.emit('playCard', { cardId: card.id });
      }
    });
    handDiv.appendChild(div);
  });

  document.getElementById('drawBtn').classList.toggle('hidden', !isMyTurn);
  document.getElementById('pageOneBtn').classList.toggle('hidden', !state.canDeclarePageOne);
  document.getElementById('ronBtn').classList.toggle('hidden', !state.canRon);
  document.getElementById('dosunBtn').classList.toggle('hidden', !state.canDosun);
  document.getElementById('ronBackBtn').classList.toggle('hidden', !state.canRonBack);
  document.getElementById('declineRonBackBtn').classList.toggle('hidden', !state.canRonBack);
  document.getElementById('passBtn').classList.toggle('hidden', !state.canPass);

  const logBox = document.getElementById('logBox');
  logBox.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  logBox.scrollTop = logBox.scrollHeight;
}

function cardCanPlay(card, topCard, currentSuit, pendingChain) {
  if (pendingChain) {
    return card.rank === pendingChain.rank || card.type === 'joker';
  }
  if (!topCard) return true;
  if (card.type === 'joker') return true;
  if (card.suit === currentSuit) return true;
  // A played joker counts as its declared number too (e.g. a joker put
  // down as "diamond 6" can be followed by any other 6).
  const topRank = topCard.type === 'joker' ? topCard.chosenRank : topCard.rank;
  if (topRank != null && card.rank === topRank) return true;
  return false;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
