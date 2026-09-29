const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Room, canRonPlayer, discardRank } = require('./game');
const { decideTurnAction, decideOpeningDeclare } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const BOT_MOVE_DELAY_MS = 900;
const botSchedulePending = new Set(); // room codes with a bot step already queued

// A dropped socket (screen sleep, backgrounded app, a network blip) looks
// identical to someone actually leaving until they either reconnect or the
// grace period runs out — deleting the room immediately would make the
// reconnect flow below pointless, especially for a solo game against bots
// where the disconnecting human is the *only* human in the room.
const ROOM_CLEANUP_DELAY_MS = 3 * 60 * 1000;
const roomCleanupTimers = new Map(); // code -> timeout handle

function cancelRoomCleanup(code) {
  const timer = roomCleanupTimers.get(code);
  if (timer) {
    clearTimeout(timer);
    roomCleanupTimers.delete(code);
  }
}

function scheduleRoomCleanup(code) {
  if (roomCleanupTimers.has(code)) return;
  const timer = setTimeout(() => {
    roomCleanupTimers.delete(code);
    const room = rooms.get(code);
    if (!room) return;
    const stillConnected = room.players.some((p) => p.connected && !p.isBot);
    if (!stillConnected) rooms.delete(code);
  }, ROOM_CLEANUP_DELAY_MS);
  roomCleanupTimers.set(code, timer);
}

function genRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function broadcastState(room) {
  for (const player of room.players) {
    if (player.isBot) continue; // bots have no real socket to send to
    io.to(player.id).emit('state', room.toClientState(player.id));
  }
  scheduleBotStep(room);
}

// Finds the single next thing a bot should do, in priority order:
// dosun/ron interrupts first (they can fire regardless of whose turn it
// is), then whatever the current turn/dice/hand-size step requires.
function findNextBotStep(room) {
  if (room.phase === 'playing' && room.winnerIds.length === 0) {
    if (room.awaitingOpeningDeclare) {
      const dealer = room.players.find((p) => p.id === room.dealerId);
      if (dealer && dealer.isBot) return { type: 'declareOpening', playerId: dealer.id };
      return null; // waiting on a human dealer to declare
    }
    if (room.awaitingRonBack) {
      const bot = room.players.find((p) => p.id === room.awaitingRonBack && p.isBot);
      if (bot) return { type: 'ronBack', playerId: bot.id };
      return null; // waiting on a human to decide
    }
    if (room.dosunAvailable && room.topCard) {
      const bot = room.players.find(
        (p) => p.isBot && room.awaitingPassFrom.includes(p.id) && canRonPlayer(p, discardRank(room.topCard))
      );
      if (bot) return { type: 'dosun', playerId: bot.id };
    }
    if (room.lastDiscardCard) {
      const target = discardRank(room.lastDiscardCard);
      const bot = room.players.find(
        (p) =>
          p.isBot &&
          room.awaitingPassFrom.includes(p.id) &&
          p.id !== room.lastDiscardPlayerId &&
          !p.furitenRanks.includes(target) &&
          canRonPlayer(p, target)
      );
      if (bot) return { type: 'ron', playerId: bot.id };
    }
    if (room.awaitingPassFrom.length > 0) {
      const botId = room.awaitingPassFrom.find((id) => room.players.find((p) => p.id === id)?.isBot);
      if (botId) return { type: 'pass', playerId: botId };
      return null; // waiting on a human to pass; nothing a bot can do yet
    }
    const current = room.currentPlayer;
    if (current && current.isBot) {
      return { type: 'turn', playerId: current.id };
    }
  } else if (room.phase === 'dice') {
    const botId = room.diceRollPending.find((id) => room.players.find((p) => p.id === id)?.isBot);
    if (botId) return { type: 'rollDice', playerId: botId };
  } else if (room.phase === 'handSize') {
    const dealer = room.players.find((p) => p.id === room.dealerId);
    if (dealer && dealer.isBot) return { type: 'chooseHandSize', playerId: dealer.id };
  }
  return null;
}

function applyBotDecision(room, bot, decision) {
  if (decision.action === 'draw') {
    room.draw(bot.id);
    if (bot.hand.length === 1 && !bot.declaredPageOne && bot.hand[0].type !== 'joker' && bot.hand[0].rank !== 8) {
      room.declarePageOne(bot.id);
    }
  } else if (decision.action === 'play') {
    room.playCard(bot.id, decision.cardId, decision.chosenSuit, decision.chosenRank);
    if (
      bot.hand.length === 1 &&
      !bot.declaredPageOne &&
      bot.hand[0].type !== 'joker' &&
      bot.hand[0].rank !== 8
    ) {
      room.declarePageOne(bot.id);
    }
  }
}

function performBotStep(room, step) {
  const bot = room.players.find((p) => p.id === step.playerId);
  if (!bot) return;
  switch (step.type) {
    case 'dosun':
      room.dosun(bot.id);
      break;
    case 'ron':
      room.ron(bot.id);
      break;
    case 'ronBack':
      // Always worth taking: it turns a loss into a bigger win.
      room.ronBack(bot.id);
      break;
    case 'pass':
      room.pass(bot.id);
      break;
    case 'rollDice':
      room.rollDice(bot.id);
      break;
    case 'chooseHandSize': {
      const size = 3 + Math.floor(Math.random() * 3); // 3〜5枚のランダム
      room.chooseHandSize(bot.id, size);
      break;
    }
    case 'declareOpening': {
      const { chosenSuit, chosenRank } = decideOpeningDeclare(room, bot);
      room.declareOpeningCard(bot.id, chosenSuit, chosenRank);
      break;
    }
    case 'turn':
      applyBotDecision(room, bot, decideTurnAction(room, bot));
      break;
    default:
      break;
  }
}

function scheduleBotStep(room) {
  if (botSchedulePending.has(room.code)) return;
  const step = findNextBotStep(room);
  if (!step) return;
  botSchedulePending.add(room.code);
  setTimeout(() => {
    botSchedulePending.delete(room.code);
    if (!rooms.has(room.code)) return; // room was cleaned up meanwhile
    performBotStep(room, step);
    broadcastState(room);
  }, BOT_MOVE_DELAY_MS);
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, clientId }) => {
    const code = genRoomCode();
    const playerId = clientId || socket.id;
    const room = new Room(code, playerId);
    room.addPlayer(playerId, (name || '名無し').slice(0, 12));
    rooms.set(code, room);
    socket.join(code);
    socket.join(playerId);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    broadcastState(room);
  });

  socket.on('joinRoom', ({ code, name, clientId }) => {
    const room = rooms.get((code || '').trim());
    if (!room) {
      socket.emit('errorMsg', '部屋が見つかりません');
      return;
    }
    if (room.phase === 'dice' || room.phase === 'handSize' || room.phase === 'playing') {
      socket.emit('errorMsg', 'すでにゲームが始まっています');
      return;
    }
    if (room.players.length >= 6) {
      socket.emit('errorMsg', '満員です');
      return;
    }
    const playerId = clientId || socket.id;
    room.addPlayer(playerId, (name || '名無し').slice(0, 12));
    socket.join(room.code);
    socket.join(playerId);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    cancelRoomCleanup(room.code);
    broadcastState(room);
  });

  // The page came back from being backgrounded/asleep with a fresh
  // socket.id — reattach it to the same seat via the persistent client id
  // instead of leaving the player stranded in the lobby.
  socket.on('rejoin', ({ code, clientId }) => {
    const room = rooms.get((code || '').trim());
    if (!room || !clientId) {
      socket.emit('rejoinFailed');
      return;
    }
    const player = room.reconnectPlayer(clientId);
    if (!player) {
      socket.emit('rejoinFailed');
      return;
    }
    socket.join(room.code);
    socket.join(clientId);
    socket.data.roomCode = room.code;
    socket.data.playerId = clientId;
    cancelRoomCleanup(room.code);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('errorMsg', 'ホストのみCPUを追加できます');
      return;
    }
    if (room.phase === 'dice' || room.phase === 'handSize' || room.phase === 'playing') {
      socket.emit('errorMsg', 'ゲーム中はCPUを追加できません');
      return;
    }
    if (room.players.length >= 6) {
      socket.emit('errorMsg', '満員です');
      return;
    }
    room.addBot();
    broadcastState(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('errorMsg', 'ホストのみCPUを削除できます');
      return;
    }
    if (room.phase === 'dice' || room.phase === 'handSize' || room.phase === 'playing') {
      socket.emit('errorMsg', 'ゲーム中はCPUを削除できません');
      return;
    }
    const result = room.removeBot(botId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('errorMsg', 'ホストのみ開始できます');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('errorMsg', '2人以上必要です');
      return;
    }
    const result = room.beginRound();
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('rollDice', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const result = room.rollDice(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('chooseHandSize', ({ size }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const result = room.chooseHandSize(socket.data.playerId, size);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('declareOpeningCard', ({ chosenSuit, chosenRank }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.declareOpeningCard(socket.data.playerId, chosenSuit, chosenRank);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('dosun', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.dosun(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('playCard', ({ cardId, chosenSuit, chosenRank }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.playCard(socket.data.playerId, cardId, chosenSuit, chosenRank);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('pass', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.pass(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('ron', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.ron(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('ronBack', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.ronBack(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('declineRonBack', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.declineRonBack(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('declarePageOne', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.declarePageOne(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('drawCard', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.draw(socket.data.playerId);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    handleDisconnect(socket);
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.removePlayer(socket.data.playerId);
  socket.data.roomCode = null;
  const stillConnected = room.players.some((p) => p.connected && !p.isBot);
  if (!stillConnected) {
    // Don't delete right away — this is indistinguishable from a screen
    // lock or a background tab until the grace period actually runs out.
    scheduleRoomCleanup(code);
    return;
  }
  broadcastState(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO online server running on http://localhost:${PORT}`);
});
