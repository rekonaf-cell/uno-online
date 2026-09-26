const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTIONS = ['skip', 'reverse', 'draw2'];

function createDeck() {
  const deck = [];
  let id = 0;
  for (const color of COLORS) {
    deck.push({ id: id++, color, type: 'number', value: 0 });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, color, type: 'number', value: n });
      deck.push({ id: id++, color, type: 'number', value: n });
    }
    for (const action of ACTIONS) {
      deck.push({ id: id++, color, type: action });
      deck.push({ id: id++, color, type: action });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, color: 'wild', type: 'wild' });
    deck.push({ id: id++, color: 'wild', type: 'wild4' });
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

function cardMatches(card, topCard, currentColor) {
  if (card.type === 'wild' || card.type === 'wild4') return true;
  if (card.color === currentColor) return true;
  if (topCard.type === 'number' && card.type === 'number') return card.value === topCard.value;
  if (topCard.type !== 'number' && card.type === topCard.type) return true;
  return false;
}

class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.players = []; // { id, name, hand: [card], connected }
    this.deck = [];
    this.discardPile = [];
    this.currentColor = null;
    this.currentPlayerIndex = 0;
    this.direction = 1;
    this.started = false;
    this.winnerId = null;
    this.pendingDraw = false; // player drew a card this turn and hasn't acted yet
    this.log = [];
  }

  addPlayer(id, name) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({ id, name, hand: [], connected: true });
  }

  removePlayer(id) {
    const p = this.players.find((pl) => pl.id === id);
    if (p) p.connected = false;
  }

  get currentPlayer() {
    return this.players[this.currentPlayerIndex];
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
    this.log = [];

    for (const player of this.players) {
      player.hand = this.deck.splice(0, 7);
    }

    let firstCard = this.deck.pop();
    while (firstCard.type === 'wild4') {
      this.deck.unshift(firstCard);
      shuffle(this.deck);
      firstCard = this.deck.pop();
    }
    this.discardPile.push(firstCard);
    this.currentColor = firstCard.color === 'wild' ? COLORS[Math.floor(Math.random() * 4)] : firstCard.color;

    this.addLog(`ゲーム開始！`);

    if (firstCard.type === 'reverse') {
      this.direction = -1;
    } else if (firstCard.type === 'skip') {
      this.advanceTurn();
    } else if (firstCard.type === 'draw2') {
      this.drawCards(this.currentPlayer, 2);
      this.advanceTurn();
    }
  }

  get topCard() {
    return this.discardPile[this.discardPile.length - 1];
  }

  drawCards(player, count) {
    for (let i = 0; i < count; i++) {
      if (this.deck.length === 0) this.reshuffleFromDiscard();
      if (this.deck.length === 0) break;
      player.hand.push(this.deck.pop());
    }
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

  playCard(playerId, cardId, chosenColor) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) return { error: 'あなたの番ではありません' };
    const player = this.players[playerIndex];
    const cardIndex = player.hand.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return { error: 'そのカードは手札にありません' };
    const card = player.hand[cardIndex];

    if (!cardMatches(card, this.topCard, this.currentColor)) {
      return { error: '出せないカードです' };
    }
    if ((card.type === 'wild' || card.type === 'wild4') && !COLORS.includes(chosenColor)) {
      return { error: '色を選んでください' };
    }

    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.pendingDraw = false;

    if (player.hand.length === 0) {
      this.winnerId = player.id;
      this.started = false;
      this.addLog(`${player.name} が上がりました！`);
      return { success: true };
    }

    if (card.type === 'wild' || card.type === 'wild4') {
      this.currentColor = chosenColor;
    } else {
      this.currentColor = card.color;
    }

    this.addLog(`${player.name} が ${describeCard(card)} を出しました`);

    if (card.type === 'reverse') {
      this.direction *= -1;
      if (this.players.length === 2) {
        this.advanceTurn();
      }
      this.advanceTurn();
    } else if (card.type === 'skip') {
      this.advanceTurn(2);
    } else if (card.type === 'draw2') {
      this.advanceTurn();
      this.drawCards(this.currentPlayer, 2);
      this.addLog(`${this.currentPlayer.name} は2枚引いて順番が飛ばされます`);
      this.advanceTurn();
    } else if (card.type === 'wild4') {
      this.advanceTurn();
      this.drawCards(this.currentPlayer, 4);
      this.addLog(`${this.currentPlayer.name} は4枚引いて順番が飛ばされます`);
      this.advanceTurn();
    } else {
      this.advanceTurn();
    }

    return { success: true };
  }

  draw(playerId) {
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) return { error: 'あなたの番ではありません' };
    if (this.pendingDraw) return { error: 'すでに山札から引いています' };
    const player = this.players[playerIndex];
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

  canPlayAny(playerId) {
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return false;
    return player.hand.some((c) => cardMatches(c, this.topCard, this.currentColor));
  }

  toClientState(forPlayerId) {
    return {
      code: this.code,
      hostId: this.hostId,
      started: this.started,
      winnerId: this.winnerId,
      direction: this.direction,
      currentColor: this.currentColor,
      currentPlayerId: this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null,
      pendingDraw: this.pendingDraw,
      topCard: this.topCard || null,
      deckCount: this.deck.length,
      log: this.log,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        connected: p.connected,
        isMe: p.id === forPlayerId,
      })),
      myHand: this.started
        ? (this.players.find((p) => p.id === forPlayerId) || { hand: [] }).hand
        : [],
    };
  }
}

function describeCard(card) {
  const colorNames = { red: '赤', yellow: '黄', green: '緑', blue: '青', wild: 'ワイルド' };
  const typeNames = { skip: 'スキップ', reverse: 'リバース', draw2: '+2', wild: 'ワイルド', wild4: 'ワイルド+4' };
  if (card.type === 'number') return `${colorNames[card.color]}の${card.value}`;
  if (card.type === 'wild' || card.type === 'wild4') return typeNames[card.type];
  return `${colorNames[card.color]}の${typeNames[card.type]}`;
}

module.exports = { Room, COLORS };
