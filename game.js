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
    this.log = [];
  }

  addPlayer(id, name) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({ id, name, hand: [], connected: true, declaredPageOne: false });
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

  start() {
    this.deck = shuffle(createDeck());
    this.discardPile = [];
    this.direction = 1;
    this.currentPlayerIndex = 0;
    this.started = true;
    this.winnerId = null;
    this.pendingDraw = false;
    this.pendingChain = null;
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;
    this.log = [];

    const handSize = 7;
    for (const player of this.players) {
      player.hand = this.deck.splice(0, handSize);
      player.declaredPageOne = false;
    }

    let firstCard = this.deck.pop();
    while (firstCard.type === 'joker' || firstCard.rank === 8) {
      this.deck.unshift(firstCard);
      shuffle(this.deck);
      firstCard = this.deck.pop();
    }
    this.discardPile.push(firstCard);
    this.currentSuit = firstCard.suit;

    this.addLog('ゲーム開始！');

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
    if (willWin && !canFinishWith(card)) {
      return { error: 'ジョーカーでは上がれません' };
    }

    if ((card.type === 'joker' || card.rank === 8) && !SUITS.includes(chosenSuit)) {
      return { error: 'マークを選んでください' };
    }

    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.pendingDraw = false;

    if (player.hand.length === 0) {
      this.winnerId = player.id;
      this.started = false;
      this.lastDiscardCard = null;
      this.lastDiscardPlayerId = null;
      this.addLog(`${player.name} が上がりました！`);
      return { success: true };
    }

    this.addLog(`${player.name} が ${describeCard(card)} を出しました`);
    this.lastDiscardCard = card.type === 'normal' ? card : null;
    this.lastDiscardPlayerId = player.id;

    if (player.hand.length === 1 && card.type !== 'joker' && card.rank !== 8) {
      player.declaredPageOne = false; // must declare fresh
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
    if (!canRon(player.hand, this.lastDiscardCard.rank)) {
      return { error: '手札の合計が一致していません' };
    }
    this.winnerId = player.id;
    this.started = false;
    const target = this.lastDiscardCard.rank;
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;
    this.addLog(`${player.name} が ロン！(合計${target}) で上がりました`);
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
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        connected: p.connected,
        isMe: p.id === forPlayerId,
        declaredPageOne: p.declaredPageOne,
      })),
      myHand: this.started && me ? me.hand : [],
      canDeclarePageOne: !!(
        me &&
        me.hand.length === 1 &&
        !me.declaredPageOne &&
        me.hand[0].type !== 'joker' &&
        me.hand[0].rank !== 8
      ),
      canRon: !!(
        this.started &&
        !this.winnerId &&
        me &&
        this.lastDiscardCard &&
        this.lastDiscardPlayerId !== forPlayerId &&
        canRon(me.hand, this.lastDiscardCard.rank)
      ),
    };
  }
}

module.exports = { Room, SUITS };
