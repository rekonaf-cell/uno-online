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
// A played joker counts as its declared number here too (e.g. a joker put
// down as "diamond 6" can be followed by any other 6, not just a diamond).
function cardMatches(card, topCard, currentSuit) {
  if (card.type === 'joker') return true;
  if (card.suit === currentSuit) return true;
  const topRank = discardRank(topCard);
  if (topRank != null && card.rank === topRank) return true;
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
  if (card.type === 'joker') {
    return card.chosenRank
      ? `ジョーカー(${suitNames[card.chosenSuit]}の${rankLabel(card.chosenRank)}扱い)`
      : 'ジョーカー';
  }
  return `${suitNames[card.suit]}の${rankLabel(card.rank)}`;
}

// The numeric value a discarded card counts as for matching purposes
// (page-one/当たり target, furiten lock). A normal card just uses its own
// rank; a joker only has one once it's been played, via the number the
// player declared for that play.
function discardRank(card) {
  return card.type === 'joker' ? card.chosenRank : card.rank;
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
    this.winnerIds = []; // usually one id, but simultaneous 当たり can produce several
    this.pendingChain = null; // { rank: 2|3, amount: N }
    this.lastDiscardCard = null; // most recent discard, ron-able until superseded
    this.lastDiscardPlayerId = null;
    this.lastWinType = null; // 'normal' | 'ron' | 'dosun'
    this.lastRoundDeltas = null; // { [playerId]: pointChange }
    this.log = [];
    this.discardHistory = []; // every card played this round, in order, never trimmed by reshuffles

    this.phase = 'lobby'; // 'lobby' | 'dice' | 'handSize' | 'playing' | 'roundEnd'
    this.dealerId = null;
    this.nextDealerCandidates = null; // set when several players won at once; next dice-off is limited to them
    this.diceContenders = [];
    this.diceRolls = {}; // { [playerId]: { d1, d2, total } }
    this.diceRollPending = [];
    this.dosunAvailable = false;
    this.botCounter = 0;

    this.awaitingPassFrom = []; // player ids who still must pass/当たり/dosun before the pending turn effect resolves
    this.pendingResolve = null; // closure that applies the deferred turn effect once everyone has passed
    this.ronClaimants = []; // player ids who claimed 当たり this pass round, collected until everyone has responded
    this.dosunClaimants = []; // same, for the opening-card ドスン window
    this.awaitingRonBack = null; // discarder's id while they decide whether to counter a 当たり claimed against them
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
    // Turn order starts from the dealer: they're the one who "exposes" the
    // opening card, so a skip/reverse/chain effect on it applies relative
    // to their seat, exactly like it would for a card someone played.
    const dealerIndex = this.players.findIndex((p) => p.id === this.dealerId);
    this.currentPlayerIndex = dealerIndex >= 0 ? dealerIndex : 0;
    this.started = true;
    this.phase = 'playing';
    this.winnerIds = [];
    this.pendingChain = null;
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;
    this.lastWinType = null;
    this.lastRoundDeltas = null;
    this.log = [];
    this.discardHistory = [];
    this.awaitingPassFrom = [];
    this.pendingResolve = null;
    this.ronClaimants = [];
    this.dosunClaimants = [];
    this.awaitingRonBack = null;

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

    // Give everyone a chance to hit the opening card with ドスン before the
    // first turn's effect (skip/reverse/chain) actually takes hold.
    this.pendingResolve = () => {
      if (firstCard.rank === 11) {
        this.direction = -1;
      } else if (firstCard.rank === 1) {
        this.advanceTurn();
      } else if (firstCard.rank === 2) {
        this.pendingChain = { rank: 2, amount: 2 };
      } else if (firstCard.rank === 3) {
        this.pendingChain = { rank: 3, amount: 3 };
      }
    };
    this.awaitingPassFrom = this.players.filter((p) => p.connected).map((p) => p.id);
    if (this.awaitingPassFrom.length === 0) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }
  }

  // Kicks off the pre-round sequence: a dice-off to pick the very first
  // dealer, or (once a dealer already exists) straight to hand-size choice.
  beginRound() {
    this.winnerIds = [];
    this.lastWinType = null;
    this.lastRoundDeltas = null;
    if (this.dealerId === null) {
      let contenders;
      if (this.nextDealerCandidates && this.nextDealerCandidates.length > 0) {
        contenders = this.nextDealerCandidates.filter((id) => this.players.find((p) => p.id === id)?.connected);
      } else {
        contenders = this.players.filter((p) => p.connected).map((p) => p.id);
      }
      this.nextDealerCandidates = null;
      if (contenders.length === 1) {
        this.dealerId = contenders[0];
        this.phase = 'handSize';
        const dealerName = this.players.find((p) => p.id === contenders[0]).name;
        this.addLog(`${dealerName} が親です。配る枚数を選んでください`);
        return { success: true };
      }
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
    // A ページワン declaration only makes sense at exactly 1 card; growing
    // back to 2+ (a chain penalty, a forced draw) clears it automatically.
    if (player.hand.length > 1) player.declaredPageOne = false;
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

  playCard(playerId, cardId, chosenSuit, chosenRank) {
    if (this.awaitingPassFrom.length > 0) return { error: '他のプレイヤーの確認待ちです' };
    const playerIndex = this.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== this.currentPlayerIndex) return { error: 'あなたの番ではありません' };
    const player = this.players[playerIndex];
    player.furitenRanks = []; // their own turn has arrived: any furiten lock clears
    this.dosunAvailable = false; // window for hitting the opening card is over

    const cardIndex = player.hand.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return { error: 'そのカードは手札にありません' };
    const card = player.hand[cardIndex];

    if (this.pendingChain) {
      if (card.type !== 'joker' && card.rank !== this.pendingChain.rank) {
        return { error: `${this.pendingChain.rank}かジョーカーで対応するか、引いてください` };
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
    const rankNum = Number(chosenRank);
    if (card.type === 'joker' && !(Number.isInteger(rankNum) && rankNum >= 1 && rankNum <= 13)) {
      return { error: '数字を選んでください' };
    }
    // A joker answering a 2/3 chain IS that 2/3 for this play: its declared
    // number must match the chain, not some unrelated value the player
    // could pick just because a joker can normally be "anything".
    if (card.type === 'joker' && this.pendingChain && rankNum !== this.pendingChain.rank) {
      return { error: `連続中は数字を${this.pendingChain.rank}にしてください` };
    }

    // A joker keeps its own identity (rank stays null) so it deals and
    // scores normally the next time it's shuffled back in; the discard
    // pile/history instead get a display-only copy carrying the number and
    // suit the player declared, so past turns never retroactively change.
    const discardedCard = card.type === 'joker' ? { ...card, chosenRank: rankNum, chosenSuit } : card;

    player.hand.splice(cardIndex, 1);
    this.discardPile.push(discardedCard);
    this.discardHistory.push(discardedCard);

    if (player.hand.length === 0) {
      this.winnerIds = [player.id];
      this.started = false;
      this.phase = 'roundEnd';
      this.dealerId = player.id;
      this.lastDiscardCard = null;
      this.lastDiscardPlayerId = null;

      // Winning with a 2/3 still leaves its draw obligation behind: the
      // next player in turn order has to draw it (stacked on top of any
      // chain already running), same as if the round were continuing.
      // This lands before scoring so it inflates their hand for the payout.
      if (card.rank === 2 || card.rank === 3) {
        const amount = (this.pendingChain && this.pendingChain.rank === card.rank ? this.pendingChain.amount : 0) + card.rank;
        const n = this.players.length;
        const nextIndex = (((playerIndex + this.direction) % n) + n) % n;
        const nextPlayer = this.players[nextIndex];
        if (nextPlayer && nextPlayer.id !== player.id) {
          this.drawCards(nextPlayer, amount);
          this.addLog(`${nextPlayer.name} は上がりの${card.rank}の影響で${amount}枚引きました`);
        }
        this.pendingChain = null;
      }

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

    this.addLog(`${player.name} が ${describeCard(discardedCard)} を出しました`);

    // The previous discard is about to be superseded. Anyone who could have
    // ronned on it but didn't is now furiten on that rank until their own
    // turn comes around — except whoever discarded it themselves, since
    // self-ron was never actually possible for them in the first place.
    if (this.lastDiscardCard) {
      const oldRank = discardRank(this.lastDiscardCard);
      for (const other of this.players) {
        if (other.id === player.id || other.id === this.lastDiscardPlayerId) continue;
        if (canRon(other.hand, oldRank) && !other.furitenRanks.includes(oldRank)) {
          other.furitenRanks.push(oldRank);
        }
      }
    }

    // A joker's declared number now makes it ron-able just like any other
    // discard, using the value the player picked for it.
    this.lastDiscardCard = discardedCard;
    this.lastDiscardPlayerId = player.id;

    if (player.hand.length === 1 && player.hand[0].type !== 'joker' && player.hand[0].rank !== 8) {
      // Eligibility to declare depends on the card THEY'D be winning with
      // (the one now left in hand), not the card they just played.
      player.declaredPageOne = false; // must declare fresh
      player.pageOneDeadline = this.discardHistory.length; // must declare before anyone else plays next
    }

    // Defer the actual turn effect (suit change / skip / reverse / chain)
    // until everyone else has had a chance to ron or explicitly pass.
    this.pendingResolve = () => {
      const chainActive = this.pendingChain;
      if (card.type === 'joker' && chainActive) {
        // Joker used to answer a 2/3 chain: extends it like a real card of
        // that rank would, rather than cancelling it.
        this.currentSuit = chosenSuit;
        this.pendingChain = { rank: chainActive.rank, amount: chainActive.amount + chainActive.rank };
        this.advanceTurn();
      } else if (card.type === 'joker' || card.rank === 8) {
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
    };

    this.awaitingPassFrom = this.players.filter((p) => p.id !== player.id && p.connected).map((p) => p.id);
    if (this.awaitingPassFrom.length === 0) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }

    return { success: true };
  }

  draw(playerId) {
    if (this.awaitingPassFrom.length > 0) return { error: '他のプレイヤーの確認待ちです' };
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

    // Drawing ends the turn outright — no playing the drawn card, even if
    // it would have been legal. Matches the "draw and pass" house rule.
    this.drawCards(player, 1);
    this.addLog(`${player.name} が山札から1枚引きました`);
    this.advanceTurn();
    return { success: true };
  }

  // A player declines to claim 当たり on the current discard (or ドスン on
  // the opening card). Once everyone who was asked has responded — pass or
  // claim — the round is settled: by anyone who claimed, or otherwise the
  // deferred turn effect from the triggering play.
  pass(playerId) {
    if (!this.awaitingPassFrom.includes(playerId)) {
      return { error: '通す必要はありません' };
    }
    this.awaitingPassFrom = this.awaitingPassFrom.filter((id) => id !== playerId);
    if (this.awaitingPassFrom.length === 0) this.resolvePassRound();
    return { success: true };
  }

  resolvePassRound() {
    if (this.ronClaimants.length > 0) {
      // The discarder just got hit — if their own remaining hand also
      // matches the rank they discarded, give them a chance to turn the
      // tables with 当たり返し before the claim is paid out normally.
      const discarder = this.players.find((p) => p.id === this.lastDiscardPlayerId);
      if (discarder && canRon(discarder.hand, discardRank(this.lastDiscardCard))) {
        this.awaitingRonBack = discarder.id;
        this.addLog(`${discarder.name} は当たり返しできます`);
        return;
      }
      this.finalizeRon();
    } else if (this.dosunClaimants.length > 0) {
      this.finalizeDosun();
    } else if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }
  }

  // Whoever won becomes the next dealer directly; if several tied for the
  // win, the next dealer is decided by a dice-off restricted to just them.
  resolveNextDealer(winnerIds) {
    if (winnerIds.length === 1) {
      this.dealerId = winnerIds[0];
      this.nextDealerCandidates = null;
    } else {
      this.dealerId = null;
      this.nextDealerCandidates = [...winnerIds];
    }
  }

  finalizeRon() {
    const discarder = this.players.find((p) => p.id === this.lastDiscardPlayerId);
    const target = discardRank(this.lastDiscardCard);
    const winners = this.ronClaimants;
    const deltas = {};
    let discarderLoss = 0;
    // The discarded card itself is back in play for scoring: the discarder
    // pays as if it were still in their hand, not as if it had already left.
    const discarderScoringHand = [...discarder.hand, this.lastDiscardCard];
    for (const winnerId of winners) {
      const winner = this.players.find((p) => p.id === winnerId);
      const pts = handScore(discarderScoringHand) * 2;
      winner.score += pts;
      deltas[winnerId] = (deltas[winnerId] || 0) + pts;
      discarderLoss += pts;
    }
    discarder.score -= discarderLoss;
    deltas[discarder.id] = (deltas[discarder.id] || 0) - discarderLoss;

    this.winnerIds = [...winners];
    this.started = false;
    this.phase = 'roundEnd';
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;
    this.awaitingPassFrom = [];
    this.pendingResolve = null;
    this.ronClaimants = [];
    this.lastWinType = 'ron';
    this.lastRoundDeltas = deltas;
    this.resolveNextDealer(winners);

    const names = winners.map((id) => this.players.find((p) => p.id === id).name).join('・');
    this.addLog(`${names} が当たり！(合計${target}) ${discarder.name}から支払い`);
  }

  // The discarder turns a 当たり claimed against them into their own win:
  // each claimant now pays the discarder instead, at double the usual
  // 当たり rate (4x their hand) as the price of a countered claim.
  ronBack(playerId) {
    if (this.awaitingRonBack !== playerId) return { error: '今は当たり返しできません' };
    const discarder = this.players.find((p) => p.id === playerId);
    const target = discardRank(this.lastDiscardCard);
    const claimants = this.ronClaimants;
    const deltas = {};
    let totalGain = 0;
    for (const claimantId of claimants) {
      const claimant = this.players.find((p) => p.id === claimantId);
      const pts = handScore(claimant.hand) * 4;
      claimant.score -= pts;
      deltas[claimantId] = (deltas[claimantId] || 0) - pts;
      totalGain += pts;
    }
    discarder.score += totalGain;
    deltas[discarder.id] = (deltas[discarder.id] || 0) + totalGain;

    this.winnerIds = [discarder.id];
    this.started = false;
    this.phase = 'roundEnd';
    this.lastDiscardCard = null;
    this.lastDiscardPlayerId = null;
    this.awaitingPassFrom = [];
    this.pendingResolve = null;
    this.ronClaimants = [];
    this.awaitingRonBack = null;
    this.lastWinType = 'ronBack';
    this.lastRoundDeltas = deltas;
    this.resolveNextDealer([discarder.id]);

    const names = claimants.map((id) => this.players.find((p) => p.id === id).name).join('・');
    this.addLog(`${discarder.name} が当たり返し！(合計${target}) ${names}から支払い`);
    return { success: true };
  }

  // Discarder declines the counter even though they were eligible; the
  // original 当たり claim(s) are paid out as normal.
  declineRonBack(playerId) {
    if (this.awaitingRonBack !== playerId) return { error: '今は当たり返しできません' };
    this.awaitingRonBack = null;
    this.finalizeRon();
    return { success: true };
  }

  finalizeDosun() {
    const target = this.topCard.rank;
    const winners = this.dosunClaimants;
    const deltas = {};
    for (const winnerId of winners) {
      const winner = this.players.find((p) => p.id === winnerId);
      for (const other of this.players) {
        if (winners.includes(other.id)) continue; // winners don't pay each other
        const pts = handScore(other.hand) * 2;
        other.score -= pts;
        deltas[other.id] = (deltas[other.id] || 0) - pts;
        winner.score += pts;
        deltas[winnerId] = (deltas[winnerId] || 0) + pts;
      }
    }

    this.winnerIds = [...winners];
    this.started = false;
    this.phase = 'roundEnd';
    this.dosunAvailable = false;
    this.awaitingPassFrom = [];
    this.pendingResolve = null;
    this.dosunClaimants = [];
    this.lastWinType = 'dosun';
    this.lastRoundDeltas = deltas;
    this.resolveNextDealer(winners);

    const names = winners.map((id) => this.players.find((p) => p.id === id).name).join('・');
    this.addLog(`${names} が「ドスン！」(合計${target}) で上がりました！`);
  }

  // Claims 当たり on the current discard. Doesn't resolve the round right
  // away — other players might also be eligible on the same card, so this
  // just records the claim and (like pass) waits for everyone being asked
  // to respond before the round is actually settled.
  ron(playerId) {
    if (!this.started || this.winnerIds.length > 0) return { error: '今は当たりを宣言できません' };
    if (!this.lastDiscardCard) return { error: '今は当たりを宣言できません' };
    if (playerId === this.lastDiscardPlayerId) return { error: '自分が出したカードには当たりを宣言できません' };
    if (!this.awaitingPassFrom.includes(playerId)) {
      return { error: '今は当たりを宣言できません' };
    }
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'プレイヤーが見つかりません' };
    if (player.furitenRanks.includes(discardRank(this.lastDiscardCard))) {
      return { error: 'この数字は一度見送っているので当たりを宣言できません(自分の番が来るまでフリテン)' };
    }
    if (!canRon(player.hand, discardRank(this.lastDiscardCard))) {
      return { error: '手札の合計が一致していません' };
    }

    this.ronClaimants.push(playerId);
    this.awaitingPassFrom = this.awaitingPassFrom.filter((id) => id !== playerId);
    this.addLog(`${player.name} が「当たり！」と宣言しました`);
    if (this.awaitingPassFrom.length === 0) this.resolvePassRound();
    return { success: true };
  }

  // Claims ドスン on the opening card. Same collect-then-settle pattern as
  // ron() above, so multiple simultaneous claims are all honored.
  dosun(playerId) {
    if (!this.started || this.winnerIds.length > 0) return { error: '今はドスンできません' };
    if (!this.dosunAvailable) return { error: '今はドスンできません' };
    if (!this.awaitingPassFrom.includes(playerId)) return { error: '今はドスンできません' };
    const player = this.players.find((p) => p.id === playerId);
    if (!player) return { error: 'プレイヤーが見つかりません' };
    if (!canRon(player.hand, this.topCard.rank)) {
      return { error: '手札の合計が一致していません' };
    }

    this.dosunClaimants.push(playerId);
    this.awaitingPassFrom = this.awaitingPassFrom.filter((id) => id !== playerId);
    this.addLog(`${player.name} が「ドスン！」と宣言しました`);
    if (this.awaitingPassFrom.length === 0) this.resolvePassRound();
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
      winnerIds: this.winnerIds,
      direction: this.direction,
      currentSuit: this.currentSuit,
      currentPlayerId: this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null,
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
        this.winnerIds.length === 0 &&
        me &&
        this.lastDiscardCard &&
        this.lastDiscardPlayerId !== forPlayerId &&
        this.awaitingPassFrom.includes(forPlayerId) &&
        !me.furitenRanks.includes(discardRank(this.lastDiscardCard)) &&
        canRon(me.hand, discardRank(this.lastDiscardCard))
      ),
      canRonBack: this.awaitingRonBack === forPlayerId,
      awaitingRonBack: this.awaitingRonBack,
      phase: this.phase,
      dealerId: this.dealerId,
      diceContenders: this.diceContenders,
      diceRollPending: this.diceRollPending,
      diceRolls: this.diceRolls,
      canRollDice: this.phase === 'dice' && this.diceRollPending.includes(forPlayerId),
      canDosun: !!(
        this.started &&
        this.winnerIds.length === 0 &&
        this.dosunAvailable &&
        me &&
        this.awaitingPassFrom.includes(forPlayerId) &&
        canRon(me.hand, this.topCard.rank)
      ),
      awaitingPassFrom: this.awaitingPassFrom,
      canPass: this.awaitingPassFrom.includes(forPlayerId),
    };
  }
}

module.exports = { Room, SUITS, cardMatches, canFinishWith, canRon, handScore, discardRank };
