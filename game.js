const SUITS = ['spade', 'heart', 'diamond', 'club'];
const JOKERS_PER_DECK = 2;
const DECKS = 2;

function createDeck() {
  const deck = [];
  let id = 0;
  for (let d = 0; d < DECKS; d++) {
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank++) {
        deck.push({ id: id++, type: 'normal', suit, rank });
      }
    }
    for (let j = 0; j < JOKERS_PER_DECK; j++) {
      deck.push({ id: id++, type: 'joker', suit: null, rank: null });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Whether `card` may legally be placed on `topCard` given the currently
// required suit. Joker is fully wild. 8 is NOT wild: it only matches when
// its suit matches, or when the top card is itself an 8 (rank match) —
// i.e. exactly the same rule as any other card, no special case needed.
function cardMatches(card, topCard, currentSuit) {
  if (card.type === 'joker') return true;
  if (card.suit === currentSuit) return true;
  if (topCard.type === 'normal' && card.rank === topCard.rank) return true;
  return false;
}

// Whether `card` may legally be the very last card of a winning play.
// Joker can never finish a hand. Every other card (including 8) can finish
// as long as it was a legal placement in the first place.
function canFinishWith(card) {
  return card.type !== 'joker';
}

// Ron: can `hand`'s total value equal `target`, treating each joker as a
// wildcard worth any single card value from 1 to 13?
function canRon(hand, target) {
  const jokerCount = hand.filter((c) => c.type === 'joker').length;
  const fixedSum = hand.filter((c) => c.type !== 'joker').reduce((s, c) => s + c.rank, 0);
  const remaining = target - fixedSum;
  if (jokerCount === 0) return remaining === 0;
  return remaining >= jokerCount * 1 && remaining <= jokerCount * 13;
}

// Point value of a single card for end-of-round scoring (NOT the same as
// its rank used for turn order / ron matching). A, 3 and Joker are all
// worth 10. J/Q/K keep 11/12/13. A "2" contributes no value on its own;
// instead every 2 in the hand doubles the total of everything else.
function cardPointValue(card) {
  if (card.type === 'joker') return 10;
  if (card.rank === 1) return 10;
  if (card.rank === 3) return 10;
  if (card.rank === 2) return 0;
  return card.rank;
}

function handScore(hand) {
  const twoCount = hand.filter((c) => c.rank === 2).length;
  const base = hand.filter((c) => c.rank !== 2).reduce((s, c) => s + cardPointValue(c), 0);
  return base * Math.pow(2, twoCount);
}

function rankLabel(rank) {
  if (rank === 1) return 'A';
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
}

const suitNames = { spade: 'スペード', heart: 'ハート', diamond: 'ダイヤ', club: 'クラブ' };

function describeCard(card) {
  if (card.type === 'joker') return 'ジョーカー';
  return `${suitNames[card.suit]}の${rankLabel(card.rank)}`;
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = []; // { id, name, hand: [card], connected, declaredPageOne }
    this.deck = [];
    this.discardPile = [];
    this.currentSuit = null;
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.started = false;
    this.winnerId = null;
    this.pendingDraw = false; // player drew a free card this turn (no active chain) and hasn't acted yet
    this.pendingChain = null; // { rank: 2|3, amount: N }
    this.lastDiscardCard = null; // most recent discard, ron-able until superseded
    this.lastDiscardPlayerId = null;
    this.lastWinType = null; // 'normal' | 'ron' | 'dosun'
    this.lastRoundDeltas = null; // { [playerId]: pointChange }
    this.log = [];
    this.discardHistory = []; // every card played this round, in order, never trimmed by reshuffles

    this.phase = 'lobby'; // 'lobby' | 'dice' | 'handSize' | 'playing' | 'roundEnd'
    this.dealerId = null;
    this.diceContenders = [];
    this.diceRolls = {}; // { [playerId]: { d1, d2, total } }
    this.diceRollPending = [];
    this.dosunAvailable = false;
    this.botCounter = 0;
  }

  addPlayer(id, name, isBot = false) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({
      id,
      name,
      hand: [],
      connected: true,
      declaredPageOne: false,
      pageOneDeadline: null, // discardHistory.length snapshot; declaring is only valid until it moves
      score: 0,
      furitenRanks: [],
      isBot,
    });
  }

  addBot() {
    this.botCounter += 1;
    const id = `bot-${this.code}-${this.botCounter}`;
    const name = `CPU${this.botCounter}`;
    this.addPlayer(id, name, true);
    return { success: true, id };
  }

  removeBot(botId) {
    const idx = this.players.findIndex((p) => p.id === botId && p.isBot);
    if (idx === -1) return { error: 'CPUが見つかりません' };
    this.players.splice(idx, 1);
    return { success: true };
  }

  removePlayer(id) {
    const p = this.players.find((pl) => pl.id === id);
    if (p) p.connected = false;
  }

  get currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  get topCard() {
    return this.discardPile[this.discardPile.length - 1];
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 30) this.log.shift();
  }

  start(handSize = 7) {
    this.deck = shuffle(createDeck());
    this.discardPile = [];
    this.direction = 1;
    this.currentPlayerIndex = 0;
    this.started = true;
    this.phase = 'playing';
    this.winnerId = null;
    this.pendingDraw = false;
    this.pendingChain = null;
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;
    this.lastWinType = null;
    this.lastRoundDeltas = null;
    this.log = [];
    this.discardHistory = [];

    for (const player of this.players) {
      player.hand = this.deck.splice(0, handSize);
      player.declaredPageOne = false;
      player.pageOneDeadline = null;
      player.furitenRanks = [];
    }

    let firstCard = this.deck.pop();
    while (firstCard.type === 'joker' || firstCard.rank === 8) {
      this.deck.unshift(firstCard);
      shuffle(this.deck);
      firstCard = this.deck.pop();
    }
    this.discardPile.push(firstCard);
    this.discardHistory.push(firstCard);
    this.currentSuit = firstCard.suit;
    this.dosunAvailable = true;

    this.addLog(`ゲーム開始！(${handSize}枚配り) 最初の場札は${describeCard(firstCard)}`);

    if (firstCard.rank === 11) {
      this.direction = -1;
    } else if (firstCard.rank === 1) {
      this.advanceTurn();
    } else if (firstCard.rank === 2) {
      this.pendingChain = { rank: 2, amount: 2 };
    } else if (firstCard.rank === 3) {
      this.pendingChain = { rank: 3, amount: 3 };
    }
  }

  // Kicks off the pre-round sequence: a dice-off to pick the very first
  // dealer, or (once a dealer already exists) straight to hand-size choice.
  beginRound() {
    this.winnerId = null;
    this.lastWinType = null;
    this.lastRoundDeltas = null;
    if (this.dealerId === null) {
      const contenders = this.players.filter((p) => p.connected).map((p) => p.id);
      if (contenders.length < 2) return { error: '2人以上必要です' };
      this.phase = 'dice';
      this.diceContenders = contenders;
      this.diceRolls = {};
      this.diceRollPending = [...contenders];
      this.addLog('親を決めるサイコロを振ってください！');
    } else {
      this.phase = 'handSize';
      const dealerName = this.players.find((p) => p.id === this.dealerId).name;
      this.addLog(`${dealerName} が親です。配る枚数を選んでください`);
    }
    return { success: true };
  }

  rollDice(playerId) {
    if (this.phase !== 'dice') return { error: '今はサイコロを振れません' };
    if (!this.diceRollPending.includes(playerId)) {
      return { error: '振る番ではないか、すでに振っています' };
    }
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const total = d1 + d2;
    this.diceRolls[playerId] = { d1, d2, total };
    this.diceRollPending = this.diceRollPending.filter((id) => id !== playerId);

    const name = this.players.find((p) => p.id === playerId).name;
    this.addLog(`${name} がサイコロで ${d1}+${d2}=${total}`);

    if (this.diceRollPending.length === 0) {
      const maxTotal = Math.max(...this.diceContenders.map((id) => this.diceRolls[id].total));
      const tied = this.diceContenders.filter((id) => this.diceRolls[id].total === maxTotal);
      if (tied.length === 1) {
        this.dealerId = tied[0];
        this.phase = 'handSize';
        const dealerName = this.players.find((p) => p.id === tied[0]).name;
        this.addLog(`${dealerName} が親に決定！`);
      } else {
        this.diceContenders = tied;
        this.diceRollPending = [...tied];
        const names = tied.map((id) => this.players.find((p) => p.id === id).name).join('・');
        this.addLog(`同点(${maxTotal})のため ${names} で振り直します`);
      }
    }
    return { success: true };
  }

  chooseHandSize(playerId, size) {
    if (this.phase !== 'handSize') return { error: '今は枚数を選べません' };
    if (playerId !== this.dealerId) return { error: '親だけが枚数を選べます' };
    const n = Number(size);
    if (!Number.isInteger(n) || n < 3) return { error: '3枚以上の整数を指定してください' };
    if (n * this.players.length + 1 > 108) {
      return { error: '人数に対して枚数が多すぎます' };
    }
    this.start(n);
    return { success: true };
  }

  drawCards(player, count) {
    let drawn = 0;
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) this.reshuffleFromDiscard();
      if (this.deck.length === 0) break;
      player.hand.push(this.deck.pop());
      drawn++;
    }
    return drawn;
  }

  reshuffleFromDiscard() {
    if (this.discardPile.length <= 1) return;
    const top = this.discardPile.pop();
    this.deck = shuffle(this.discardPile);
    this.discardPile = [top];
  }

  advanceTurn(steps = 1) {
    const n = this.players.length;
    this.currentPlayerIndex = (((this.currentPlayerIndex + steps * this.direction) % n) + n) % n;
  }

  playCard(playerId, cardId, chosenSuit) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) return { error: 'あなたの番ではありません' };
    const player = this.players[playerIndex];
    player.furitenRanks = []; // their own turn has arrived: any furiten lock clears
    this.dosunAvailable = false; // window for hitting the opening card is over

    const cardIndex = player.hand.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return { error: 'そのカードは手札にありません' };
    const card = player.hand[cardIndex];

    if (this.pendingChain) {
      if (card.rank !== this.pendingChain.rank) {
        return { error: `${this.pendingChain.rank}のカードで対応するか、引いてください` };
      }
    } else if (!cardMatches(card, this.topCard, this.currentSuit)) {
      return { error: '出せないカードです' };
    }

    const willWin = player.hand.length === 1;
    if (willWin) {
      if (!canFinishWith(card)) {
        return { error: 'ジョーカーでは上がれません' };
      }
      if (card.rank !== 8 && !player.declaredPageOne) {
        return { error: 'ページワンを宣言していないので今は上がれません。カードを引いてください' };
      }
    }

    if ((card.type === 'joker' || card.rank === 8) && !SUITS.includes(chosenSuit)) {
      return { error: 'マークを選んでください' };
    }

    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.discardHistory.push(card);
    this.pendingDraw = false;

    if (player.hand.length === 0) {
      this.winnerId = player.id;
      this.started = false;
      this.phase = 'roundEnd';
      this.dealerId = player.id;
      this.lastDiscardCard = null;
      this.lastDiscardPlayerId = null;

      const deltas = {};
      let totalGain = 0;
      for (const other of this.players) {
        if (other.id === player.id) continue;
        const pts = handScore(other.hand);
        other.score -= pts;
        deltas[other.id] = -pts;
        totalGain += pts;
      }
      player.score += totalGain;
      deltas[player.id] = totalGain;
      this.lastWinType = 'normal';
      this.lastRoundDeltas = deltas;

      this.addLog(`${player.name} が上がりました！(+${totalGain}点)`);
      return { success: true };
    }

    this.addLog(`${player.name} が ${describeCard(card)} を出しました`);

    // The previous discard is about to be superseded. Anyone who could have
    // ronned on it but didn't is now furiten on that rank until their own
    // turn comes around.
    if (this.lastDiscardCard) {
      const oldRank = this.lastDiscardCard.rank;
      for (const other of this.players) {
        if (other.id === player.id) continue;
        if (canRon(other.hand, oldRank) && !other.furitenRanks.includes(oldRank)) {
          other.furitenRanks.push(oldRank);
        }
      }
    }

    this.lastDiscardCard = card.type === 'normal' ? card : null;
    this.lastDiscardPlayerId = player.id;

    if (player.hand.length === 1 && card.type !== 'joker' && card.rank !== 8) {
      player.declaredPageOne = false; // must declare fresh
      player.pageOneDeadline = this.discardHistory.length; // must declare before anyone else plays next
    }

    if (card.type === 'joker' || card.rank === 8) {
      this.currentSuit = chosenSuit;
      this.pendingChain = null;
      this.advanceTurn();
    } else {
      this.currentSuit = card.suit;
      if (card.rank === 1) {
        this.pendingChain = null;
        this.advanceTurn(2);
      } else if (card.rank === 2) {
        this.pendingChain = { rank: 2, amount: (this.pendingChain ? this.pendingChain.amount : 0) + 2 };
        this.advanceTurn();
      } else if (card.rank === 3) {
        this.pendingChain = { rank: 3, amount: (this.pendingChain ? this.pendingChain.amount : 0) + 3 };
        this.advanceTurn();
      } else if (card.rank === 11) {
        this.pendingChain = null;
        this.direction *= -1;
        if (this.players.length === 2) this.advanceTurn();
        this.advanceTurn();
      } else {
        this.pendingChain = null;
        this.advanceTurn();
      }
    }

    return { success: true };
  }

  draw(playerId) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) return { error: 'あなたの番ではありません' };
    const player = this.players[playerIndex];
    player.furitenRanks = []; // their own turn has arrived: any furiten lock clears
    this.dosunAvailable = false; // window for hitting the opening card is over

    if (this.pendingChain) {
      const amount = this.pendingChain.amount;
      this.drawCards(player, amount);
      this.addLog(`${player.name} が ${amount}枚引きました`);
      this.pendingChain = null;
      this.advanceTurn();
      return { success: true };
    }

    if (this.pendingDraw) return { error: 'すでに山札から引いています' };
    this.drawCards(player, 1);
    this.pendingDraw = true;
    this.addLog(`${player.name} が山札から1枚引きました`);
    return { success: true };
  }

  endTurn(playerId) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) return { error: 'あなたの番ではありません' };
    if (!this.pendingDraw) return { error: 'カードを引いてから終了してください' };
    this.pendingDraw = false;
    this.advanceTurn();
    return { success: true };
  }

  ron(playerId) {
    if (!this.started || this.winnerId) return { error: '今はロンできません' };
    if (!this.lastDiscardCard) return { error: '今はロンできません' };
    if (playerId === this.lastDiscardPlayerId) return { error: '自分が出したカードにはロンできません' };
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'プレイヤーが見つかりません' };
    if (player.furitenRanks.includes(this.lastDiscardCard.rank)) {
      return { error: 'この数字は一度見送っているのでロンできません(自分の番が来るまでフリテン)' };
    }
    if (!canRon(player.hand, this.lastDiscardCard.rank)) {
      return { error: '手札の合計が一致していません' };
    }
    const discarder = this.players.find((p) => p.id === this.lastDiscardPlayerId);
    const target = this.lastDiscardCard.rank;
    const pts = handScore(discarder.hand) * 2;

    this.winnerId = player.id;
    this.started = false;
    this.phase = 'roundEnd';
    this.dealerId = player.id;
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;

    discarder.score -= pts;
    player.score += pts;
    this.lastWinType = 'ron';
    this.lastRoundDeltas = { [player.id]: pts, [discarder.id]: -pts };

    this.addLog(`${player.name} が ロン！(合計${target}) ${discarder.name}から${pts}点`);
    return { success: true };
  }

  dosun(playerId) {
    if (!this.started || this.winnerId) return { error: '今はドスンできません' };
    if (!this.dosunAvailable) return { error: '今はドスンできません' };
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'プレイヤーが見つかりません' };
    if (!canRon(player.hand, this.topCard.rank)) {
      return { error: '手札の合計が一致していません' };
    }

    const target = this.topCard.rank;
    const deltas = {};
    let totalGain = 0;
    for (const other of this.players) {
      if (other.id === player.id) continue;
      const pts = handScore(other.hand) * 2;
      other.score -= pts;
      deltas[other.id] = -pts;
      totalGain += pts;
    }
    player.score += totalGain;
    deltas[player.id] = totalGain;

    this.winnerId = player.id;
    this.started = false;
    this.phase = 'roundEnd';
    this.dealerId = player.id;
    this.dosunAvailable = false;
    this.lastWinType = 'dosun';
    this.lastRoundDeltas = deltas;

    this.addLog(`${player.name} が「ドスン！」(合計${target}) で上がりました！(+${totalGain}点)`);
    return { success: true };
  }

  declarePageOne(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'プレイヤーが見つかりません' };
    if (player.hand.length !== 1) return { error: '残り1枚のときだけ宣言できます' };
    const card = player.hand[0];
    if (card.type === 'joker' || card.rank === 8) {
      return { error: 'ジョーカー・8では宣言できません' };
    }
    if (player.pageOneDeadline !== this.discardHistory.length) {
      return { error: 'タイミングを逃しました(次の人が出す前に宣言してください)' };
    }
    player.declaredPageOne = true;
    this.addLog(`${player.name} が「ページワン！」と宣言しました`);
    return { success: true };
  }

  toClientState(forPlayerId) {
    const me = this.players.find((p) => p.id === forPlayerId);
    return {
      code: this.code,
      hostId: this.hostId,
      started: this.started,
      winnerId: this.winnerId,
      direction: this.direction,
      currentSuit: this.currentSuit,
      currentPlayerId: this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null,
      pendingDraw: this.pendingDraw,
      pendingChain: this.pendingChain,
      topCard: this.topCard || null,
      deckCount: this.deck.length,
      log: this.log,
      discardHistory: this.discardHistory,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        connected: p.connected,
        isMe: p.id === forPlayerId,
        declaredPageOne: p.declaredPageOne,
        score: p.score,
        isBot: p.isBot,
      })),
      myHand: this.started && me ? me.hand : [],
      lastWinType: this.lastWinType,
      lastRoundDeltas: this.lastRoundDeltas,
      canDeclarePageOne: !!(
        me &&
        me.hand.length === 1 &&
        !me.declaredPageOne &&
        me.hand[0].type !== 'joker' &&
        me.hand[0].rank !== 8 &&
        me.pageOneDeadline === this.discardHistory.length
      ),
      canRon: !!(
        this.started &&
        !this.winnerId &&
        me &&
        this.lastDiscardCard &&
        this.lastDiscardPlayerId !== forPlayerId &&
        !me.furitenRanks.includes(this.lastDiscardCard.rank) &&
        canRon(me.hand, this.lastDiscardCard.rank)
      ),
      phase: this.phase,
      dealerId: this.dealerId,
      diceContenders: this.diceContenders,
      diceRollPending: this.diceRollPending,
      diceRolls: this.diceRolls,
      canRollDice: this.phase === 'dice' && this.diceRollPending.includes(forPlayerId),
      canDosun: !!(
        this.started &&
        !this.winnerId &&
        this.dosunAvailable &&
        me &&
        canRon(me.hand, this.topCard.rank)
      ),
    };
  }
}

module.exports = { Room, SUITS, cardMatches, canFinishWith, canRon, handScore };
