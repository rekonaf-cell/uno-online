const { cardMatches, canFinishWith } = require('./game');

// Rough point weight used only to decide which card a bot dumps first —
// intentionally the same shape as handScore's per-card value, but a bot
// doesn't need the "2 doubles everything" interaction, just a priority.
function priorityValue(card) {
  if (card.type === 'joker') return 10;
  if (card.rank === 1 || card.rank === 3) return 10;
  if (card.rank === 2) return -1; // hang on to 2s a little longer; situational
  return card.rank;
}

// A joker played to the discard now needs a declared number too. No
// opponent info to reason from, so just pick something unpredictable.
function pickRank() {
  return 1 + Math.floor(Math.random() * 13);
}

function pickSuit(hand, excludeCardId) {
  const counts = { spade: 0, heart: 0, diamond: 0, club: 0 };
  for (const c of hand) {
    if (c.id === excludeCardId) continue;
    if (c.type === 'normal' && c.suit) counts[c.suit] += 1;
  }
  let best = 'spade';
  let bestCount = -1;
  for (const suit of Object.keys(counts)) {
    if (counts[suit] > bestCount) {
      best = suit;
      bestCount = counts[suit];
    }
  }
  return best;
}

// Would playing `card` right now be legal, given that it might be the
// bot's very last card? cardMatches() only checks placement, not the
// separate win-eligibility rules (joker can never finish; a normal card
// needs a prior page-one declaration; only 8 is exempt).
function legalToPlay(bot, card) {
  if (bot.hand.length !== 1) return true;
  if (!canFinishWith(card)) return false;
  if (card.rank !== 8 && !bot.declaredPageOne) return false;
  return true;
}

function choosePlay(playable, bot) {
  const legal = playable.filter((c) => legalToPlay(bot, c));
  if (legal.length === 0) return { action: 'draw' };

  const winners = legal.filter((c) => bot.hand.length === 1);
  const pickFrom = winners.length > 0 ? winners : legal;

  const normals = pickFrom.filter((c) => c.type === 'normal' && c.rank !== 8);
  const pool = normals.length > 0 ? normals : pickFrom;
  pool.sort((a, b) => priorityValue(b) - priorityValue(a));
  const chosen = pool[0];

  if (chosen.type === 'joker') {
    return {
      action: 'play',
      cardId: chosen.id,
      chosenSuit: pickSuit(bot.hand, chosen.id),
      chosenRank: pickRank(),
    };
  }
  if (chosen.rank === 8) {
    return { action: 'play', cardId: chosen.id, chosenSuit: pickSuit(bot.hand, chosen.id) };
  }
  return { action: 'play', cardId: chosen.id };
}

// What should a bot do on its own turn, before drawing?
function decideTurnAction(room, bot) {
  if (room.pendingChain) {
    const rankMatch = bot.hand.find((c) => c.rank === room.pendingChain.rank && legalToPlay(bot, c));
    if (rankMatch) return { action: 'play', cardId: rankMatch.id };
    // A joker can answer the chain too, but never as a lone last card —
    // that would be an illegal "win" with a joker.
    const jokerMatch = bot.hand.length > 1 ? bot.hand.find((c) => c.type === 'joker') : null;
    if (jokerMatch) {
      return {
        action: 'play',
        cardId: jokerMatch.id,
        chosenSuit: pickSuit(bot.hand, jokerMatch.id),
        chosenRank: pickRank(),
      };
    }
    return { action: 'draw' };
  }

  const playable = bot.hand.filter((c) => cardMatches(c, room.topCard, room.currentSuit));
  if (playable.length === 0) return { action: 'draw' };
  return choosePlay(playable, bot);
}

// What should a bot do after a free draw (pendingDraw is true)?
function decideAfterDraw(room, bot) {
  const playable = bot.hand.filter((c) => cardMatches(c, room.topCard, room.currentSuit));
  if (playable.length === 0) return { action: 'endTurn' };
  const decision = choosePlay(playable, bot);
  return decision.action === 'draw' ? { action: 'endTurn' } : decision;
}

module.exports = { decideTurnAction, decideAfterDraw };
