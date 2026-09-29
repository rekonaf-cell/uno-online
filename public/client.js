const socket = io();

// A persistent id survives page reloads and socket reconnects (screen
// sleep, backgrounding another app, a network blip) — socket.id does not,
// it's reissued on every reconnect. The server keys players by this id, so
// losing track of it client-side would strand a reconnecting player in the
// lobby with no way back into their seat.
function getClientId() {
  try {
    let id = localStorage.getItem('pageOneClientId');
    if (!id) {
      id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'c-' + Math.random().toString(36).slice(2) + Date.now();
      localStorage.setItem('pageOneClientId', id);
    }
    return id;
  } catch (e) {
    return 'c-' + Math.random().toString(36).slice(2) + Date.now();
  }
}

// Read once and reused everywhere — never re-read from storage mid-session,
// so this tab's identity can't shift under it (e.g. another tab in the same
// browser changing the stored value, or a transient storage error handing
// back a different fallback on a later call).
const CLIENT_ID = getClientId();

function saveSession(roomCode) {
  try {
    localStorage.setItem('pageOneSession', JSON.stringify({ roomCode, clientId: CLIENT_ID }));
  } catch (e) {
    // Ignore — worst case a reload drops back to the lobby.
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem('pageOneSession');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem('pageOneSession');
  } catch (e) {
    // Ignore.
  }
}

const screens = {
  lobby: document.getElementById('lobby'),
  waiting: document.getElementById('waiting'),
  game: document.getElementById('game'),
};

// Best-effort: keep the screen from sleeping during an active game so the
// reconnect flow above rarely has to kick in. Not supported everywhere and
// never required for correctness, so failures are silently ignored.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch (e) {
    // Not supported, denied, or the tab isn't visible — ignore.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock && !screens.game.classList.contains('hidden')) {
    requestWakeLock();
  }
});

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('hidden', key !== name);
  }
  if (name === 'game') requestWakeLock();
}

let myId = null;
let pendingSuitCardId = null;
let pendingIsJoker = false;
let pendingIsOpeningDeclare = false; // dealer declaring a suit(+number) for an opening joker/8, not playing a card
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

// --- 効果音(WebAudioで合成。音声ファイルを持たずに済む) ---
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) {
    return null;
  }
}
// Any real click on the page is a user gesture — use the first one to
// unlock audio so later socket-driven sounds (a bot's move) aren't blocked.
document.addEventListener('click', () => ensureAudio(), { once: true });

function noiseBurst(ctx, now, duration, filterType, freqFrom, freqTo, gainPeak) {
  const bufferSize = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(freqFrom, now);
  filter.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), now + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainPeak, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  noise.connect(filter).connect(gain).connect(ctx.destination);
  noise.start(now);
  noise.stop(now + duration);
}

function playDrawSound() {
  const ctx = ensureAudio();
  if (!ctx) return;
  noiseBurst(ctx, ctx.currentTime, 0.16, 'bandpass', 2200, 500, 0.22);
}

function playCardSound() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  noiseBurst(ctx, now, 0.07, 'highpass', 1800, 1800, 0.3);
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(700, now);
  osc.frequency.exponentialRampToValueAtTime(180, now + 0.05);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.05);
}

// --- 山札↔プレイヤー間のカードが飛ぶ演出 ---
function getSeatAvatarEl(playerId) {
  if (playerId === myId) return document.querySelector('#selfSeat .seat-avatar');
  return document.querySelector(`.seat[data-player-id="${CSS.escape(playerId)}"] .seat-avatar`);
}

function flyCard(fromEl, toEl, faceLabel, colorClass) {
  if (!fromEl || !toEl) return;
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'fly-card' + (faceLabel ? ' ' + colorClass : ' back');
  if (faceLabel) ghost.textContent = faceLabel;
  document.body.appendChild(ghost);
  const startX = fromRect.left + fromRect.width / 2 - 15;
  const startY = fromRect.top + fromRect.height / 2 - 21;
  const endX = toRect.left + toRect.width / 2 - 15;
  const endY = toRect.top + toRect.height / 2 - 21;
  ghost.style.left = startX + 'px';
  ghost.style.top = startY + 'px';
  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${endX - startX}px, ${endY - startY}px) rotate(${faceLabel ? -20 : 20}deg)`;
    ghost.style.opacity = '0';
  });
  setTimeout(() => ghost.remove(), 720);
}

function showSpeechBubble(playerId, text) {
  const avatar = getSeatAvatarEl(playerId);
  if (!avatar) return;
  const rect = avatar.getBoundingClientRect();
  const bubble = document.createElement('div');
  bubble.className = 'speech-bubble';
  bubble.textContent = text;
  // Place the bubble on the table side of the avatar (toward the table centre).
  const tableEl = document.getElementById('historyStack');
  const tr = tableEl ? tableEl.getBoundingClientRect() : null;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let dx = 0;
  let dy = -1;
  if (tr) {
    dx = tr.left + tr.width / 2 - cx;
    dy = tr.top + tr.height / 2 - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
  }
  const dist = rect.width / 2 + 34;
  const bx = Math.min(Math.max(cx + dx * dist, 70), window.innerWidth - 70);
  const by = cy + dy * dist;
  bubble.style.left = bx + 'px';
  bubble.style.top = by + 'px';
  bubble.style.transform = '';
  document.body.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add('show'));
  // Timed to have finished fading out right as the (delayed) win modal
  // opens, so it doesn't end up floating stale on top of it.
  setTimeout(() => {
    bubble.classList.remove('show');
    setTimeout(() => bubble.remove(), 250);
  }, 1750);
}

function tone(ctx, type, freqFrom, freqTo, start, dur, peak) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, start);
  if (freqTo !== freqFrom) osc.frequency.exponentialRampToValueAtTime(freqTo, start + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.03, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// ドン！の「フリーズ」演出: 暗転 → 静寂 → 光が走る → 金色の爆発。
// 戻り値は演出の長さ(ms)。タップで飛ばせる。
const DOSUN_FREEZE_MS = 4600;
let dosunFreezeTimer = null;

// もう一つの演出: 「プチュン」とブラウン管のように暗転し、勝者の手札を
// 1枚ずつ開いていく。所要時間は手札の枚数で変わる。タップで飛ばせる。
function playDosunPuchun(rows, onDone) {
  const old = document.getElementById('dosunFreeze');
  if (old) old.remove();
  clearTimeout(dosunFreezeTimer);
  const ov = document.createElement('div');
  ov.id = 'dosunFreeze';
  ov.className = 'puchun';
  ov.innerHTML = '<div class="df-line"></div><div class="df-rows"></div><div class="df-text">ドン！！</div>';
  const rowsDiv = ov.querySelector('.df-rows');
  const cardEls = [];
  for (const row of rows) {
    const r = document.createElement('div');
    r.className = 'df-row';
    const label = document.createElement('div');
    label.className = 'df-name2';
    label.textContent = row.name;
    r.appendChild(label);
    const cs = document.createElement('div');
    cs.className = 'df-cards';
    for (const card of row.cards) {
      const c = document.createElement('div');
      c.className = 'mini-card df-card ' + cardColorClass(card);
      c.textContent = cardLabel(card);
      cs.appendChild(c);
      cardEls.push(c);
    }
    r.appendChild(cs);
    rowsDiv.appendChild(r);
  }
  document.body.appendChild(ov);

  const START = 1300;
  const STEP = 520;
  const total = START + cardEls.length * STEP + 1500;
  const ctx = ensureAudio();
  if (ctx) {
    const t = ctx.currentTime;
    tone(ctx, 'sine', 1800, 60, t + 0.02, 0.28, 0.5); // プチュン
    noiseBurst(ctx, t + 0.02, 0.08, 'highpass', 4000, 4000, 0.3);
  }
  const timers = [];
  cardEls.forEach((el, i) => {
    timers.push(
      setTimeout(() => {
        el.classList.add('open');
        const c = ensureAudio();
        if (c) {
          const n = c.currentTime;
          tone(c, 'triangle', 660 + i * 70, 660 + i * 70, n, 0.18, 0.18);
          noiseBurst(c, n, 0.05, 'highpass', 2500, 2500, 0.15);
        }
      }, START + i * STEP)
    );
  });
  timers.push(
    setTimeout(() => {
      ov.classList.add('finale');
      const c = ensureAudio();
      if (c) {
        const n = c.currentTime;
        tone(c, 'sine', 100, 35, n, 0.9, 0.7);
        noiseBurst(c, n, 0.6, 'lowpass', 2500, 100, 0.6);
        [784, 1047, 1319, 1568].forEach((f, i) => tone(c, 'triangle', f, f, n + 0.05 + i * 0.08, 0.8, 0.15));
      }
    }, START + cardEls.length * STEP + 300)
  );

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    clearTimeout(dosunFreezeTimer);
    ov.classList.add('out');
    setTimeout(() => ov.remove(), 400);
    onDone();
  };
  ov.addEventListener('click', finish);
  void ov.offsetWidth;
  ov.classList.add('go');
  dosunFreezeTimer = setTimeout(finish, total);
}

function playDosunFreeze(winnerNames, onDone) {
  const old = document.getElementById('dosunFreeze');
  if (old) old.remove();
  clearTimeout(dosunFreezeTimer);
  const ov = document.createElement('div');
  ov.id = 'dosunFreeze';
  ov.innerHTML =
    '<div class="df-rays"></div><div class="df-crack"></div>' +
    '<div class="df-text">ドン！！</div><div class="df-name"></div>';
  ov.querySelector('.df-name').textContent = winnerNames;
  document.body.appendChild(ov);

  const ctx = ensureAudio();
  if (ctx) {
    const t = ctx.currentTime;
    tone(ctx, 'sine', 110, 32, t + 0.05, 0.9, 0.7); // 暗転の重低音
    noiseBurst(ctx, t + 0.05, 0.5, 'lowpass', 500, 60, 0.5);
    tone(ctx, 'sawtooth', 40, 55, t + 1.2, 1.0, 0.12); // 静寂の中の唸り
    const b = t + 2.2; // 発光
    noiseBurst(ctx, b, 0.9, 'lowpass', 3000, 100, 0.7);
    tone(ctx, 'sine', 90, 30, b, 1.1, 0.8);
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => {
      tone(ctx, 'triangle', f, f, b + 0.1 + i * 0.09, 0.9, 0.16);
      tone(ctx, 'sine', f * 2, f * 2, b + 0.1 + i * 0.09, 0.6, 0.05);
    });
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(dosunFreezeTimer);
    ov.classList.add('out');
    setTimeout(() => ov.remove(), 400);
    onDone();
  };
  ov.addEventListener('click', finish);
  void ov.offsetWidth;
  ov.classList.add('go');
  dosunFreezeTimer = setTimeout(finish, DOSUN_FREEZE_MS);
}

let lastAnimatedActionSeq = null; // null = haven't seen a state yet, so the first one is a join/reload, not a new move
function handleActionAnimation(state) {
  const action = state.lastAction;
  if (!action) return;
  if (lastAnimatedActionSeq === null) {
    lastAnimatedActionSeq = action.seq;
    return;
  }
  if (action.seq === lastAnimatedActionSeq) return;
  lastAnimatedActionSeq = action.seq;

  const avatar = getSeatAvatarEl(action.playerId);
  const pile = document.getElementById('drawPile');
  const center = document.getElementById('historyStack');
  if (action.type === 'draw') {
    playDrawSound();
    flyCard(pile, avatar, null, null);
  } else if (action.type === 'play') {
    playCardSound();
    if (action.chainCount >= 4) showSpeechBubble(action.playerId, '容赦せんよ！！');
    const card = state.topCard;
    flyCard(avatar, center, card ? cardLabel(card) : '', card ? cardColorClass(card) : '');
  }
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
let pendingWinSig = null; // a 当たり's win modal is delayed briefly so its speech bubble is seen first
let revealedWinSig = null; // signature of the win the modal is currently (or was last) shown for

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
  pendingJoin = true;
  socket.emit('createRoom', { name, clientId: CLIENT_ID });
});

document.getElementById('joinBtn').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const code = document.getElementById('codeInput').value.trim();
  if (!name) return showToast('ニックネームを入力してください');
  if (!code) return showToast('部屋コードを入力してください');
  pendingJoin = true;
  socket.emit('joinRoom', { name, code, clientId: CLIENT_ID });
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

function leaveToLobby() {
  if (!window.confirm('本当に部屋に戻りますか？\n（ゲームから抜けます）')) return;
  socket.emit('leaveRoom');
  clearSession();
  document.getElementById('winModal').classList.add('hidden');
  document.getElementById('suitModal').classList.add('hidden');
  document.getElementById('leaveBtn').classList.add('hidden');
  leftRoom = true;
  showScreen('lobby');
}
let leftRoom = false;
let pendingJoin = false;
document.getElementById('leaveBtn').addEventListener('click', leaveToLobby);
document.getElementById('leaveBtnWin').addEventListener('click', leaveToLobby);

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
  pendingIsOpeningDeclare = false;
  pendingChosenSuit = null;
  pendingChosenRank = null;
}

function tryEmitPendingPlay() {
  if (pendingChosenSuit === null) return;
  if (pendingIsJoker && pendingChosenRank === null) return;
  if (pendingIsOpeningDeclare) {
    socket.emit('declareOpeningCard', {
      chosenSuit: pendingChosenSuit,
      chosenRank: pendingIsJoker ? pendingChosenRank : undefined,
    });
    resetPendingSuitModal();
    return;
  }
  if (pendingSuitCardId === null) return;
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
  myId = CLIENT_ID;
  // A reconnect (screen woke back up, app came back to the foreground,
  // the network blipped) gets a brand new socket.id, so if we were mid
  // game, ask the server to reattach this socket to that same seat
  // instead of sitting in the lobby with a dead connection.
  const session = loadSession();
  if (session && session.clientId === myId) {
    socket.emit('rejoin', { code: session.roomCode, clientId: myId });
  }
});

socket.on('rejoinFailed', () => {
  // The room's gone (cleaned up after the grace period) or never existed
  // for this id — stop trying and let the player start over from the lobby.
  clearSession();
});

socket.on('errorMsg', (msg) => showToast(msg));

socket.on('state', (state) => {
  myId = CLIENT_ID;
  if (leftRoom && !pendingJoin) return;
  leftRoom = false;
  pendingJoin = false;
  document.getElementById('leaveBtn').classList.remove('hidden');
  if (state.code) saveSession(state.code);
  render(state);
});

// Mobile browsers can fully suspend a backgrounded tab (screen lock,
// switching apps) — timers stop, and the socket can silently die without
// ever firing its own 'disconnect' handling in time. Nudge a reconnect as
// soon as the tab is visible again instead of waiting for it.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket.disconnected) {
    socket.connect();
  }
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
    handleActionAnimation(state);
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
    const isNewWin = scoreSig !== lastScoreAnimSignature;
    if (isNewWin) lastScoreAnimSignature = scoreSig;

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

    // 当たりでの勝利は、テーブル上の当てた本人のアイコンから「そいよ」の
    // 吹き出しを一瞬だけ見せてから結果モーダルを開く。それ以外の勝ち方
    // (通常上がり・ドン)は従来通り即座にモーダルを開く。
    if (isNewWin && state.lastWinType === 'ron') {
      pendingWinSig = scoreSig;
      for (const w of winners) showSpeechBubble(w.id, 'そいよ');
      setTimeout(() => {
        if (pendingWinSig !== scoreSig) return; // 別の勝敗に上書きされた
        revealedWinSig = scoreSig;
        document.getElementById('winModal').classList.remove('hidden');
        scoreAnimGeneration += 1;
        playAllScoreAnims(state, scoreAnimGeneration);
      }, 2000);
    } else if (isNewWin && state.lastWinType === 'dosun') {
      pendingWinSig = scoreSig;
      const revealRows = winners.map((w) => ({ name: w.name, cards: (state.revealedHands && state.revealedHands[w.id]) || [] }));
      const showFreeze = Math.random() < 0.5 || revealRows.every((r) => r.cards.length === 0);
      const afterCutscene = () => {
        if (pendingWinSig !== scoreSig) return;
        revealedWinSig = scoreSig;
        document.getElementById('winModal').classList.remove('hidden');
        scoreAnimGeneration += 1;
        playAllScoreAnims(state, scoreAnimGeneration);
      };
      if (showFreeze) playDosunFreeze(winnerNames, afterCutscene);
      else playDosunPuchun(revealRows, afterCutscene);
    } else if (isNewWin) {
      pendingWinSig = scoreSig;
      revealedWinSig = scoreSig;
      document.getElementById('winModal').classList.remove('hidden');
      scoreAnimGeneration += 1;
      playAllScoreAnims(state, scoreAnimGeneration);
    } else if (revealedWinSig === scoreSig) {
      // すでに開き終えている同じ勝敗の再描画(再接続やログ更新など) —
      // アニメーションはやり直さず、モーダルの表示だけ保つ
      document.getElementById('winModal').classList.remove('hidden');
    }
    // else: 吹き出し演出の遅延待ち中(pendingWinSig === scoreSig) — 何もせず
    // 非表示のままにして、上のsetTimeoutに開かせる
    return;
  }
  showScreen('game');
  renderGame(state);
  handleActionAnimation(state);
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

let lastGameState = null;
// Tapping anywhere that isn't a hand card or a button puts a raised card back.
document.addEventListener('click', (e) => {
  if (raisedCardId === null || !lastGameState) return;
  if (e.target.closest('#hand .card, button, .modal')) return;
  raisedCardId = null;
  renderGame(lastGameState);
});
function renderGame(state) {
  lastGameState = state;
  const me = state.players.find((p) => p.id === myId);
  // Clockwise seating starting from whoever plays right after me, so every
  // screen shows the same table ring, just rotated to put "me" at the bottom.
  const myIdx = state.players.findIndex((p) => p.id === myId);
  const others =
    myIdx === -1
      ? state.players.filter((p) => p.id !== myId)
      : [...state.players.slice(myIdx + 1), ...state.players.slice(0, myIdx)];

  // Opening card was a joker/8: the dealer needs to declare a suit (and,
  // for a joker, a number) before ドン can even be judged. Auto-open the
  // same suit/rank modal used for playing one, but wired to declare
  // instead — guarded so it only opens once, not on every re-render while
  // the dealer is still picking.
  if (state.awaitingOpeningDeclare && state.dealerId === myId && !pendingIsOpeningDeclare) {
    pendingIsOpeningDeclare = true;
    pendingIsJoker = state.topCard && state.topCard.type === 'joker';
    pendingSuitCardId = null;
    pendingChosenSuit = null;
    pendingChosenRank = null;
    document.getElementById('suitModal').classList.remove('hidden');
    document.getElementById('rankChooser').classList.toggle('hidden', !pendingIsJoker);
    // Declaring the very first card of the game: there's no board to
    // match against yet, so this one really is fully free.
    document.getElementById('jokerMatchHint').classList.add('hidden');
  }

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
    div.dataset.playerId = p.id;
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
  const waitingForOthers = awaitingPassFrom.length > 0 || !!state.awaitingRonBack || !!state.awaitingOpeningDeclare;
  const isMyTurn = state.currentPlayerId === myId && !waitingForOthers;
  const turnInfo = document.getElementById('turnInfo');
  let info = '';
  if (state.awaitingOpeningDeclare) {
    const dealer = state.players.find((p) => p.id === state.dealerId);
    info =
      state.dealerId === myId
        ? 'あなたが最初のカードを宣言してください'
        : `${dealer ? dealer.name : ''} が最初のカードを宣言中…`;
  } else if (state.awaitingRonBack) {
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
  if (!state.awaitingOpeningDeclare) {
    info += ` / 場のマーク: ${suitSymbols[state.currentSuit] || ''}${suitNames[state.currentSuit] || ''}`;
  }
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
        // A standalone joker play still has to match the board on suit or
        // number — only the chain-answer case (locked above) is exempt.
        document.getElementById('jokerMatchHint').classList.toggle('hidden', lockedRank !== null);
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
