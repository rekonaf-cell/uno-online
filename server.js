const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Room } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function genRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

function broadcastState(room) {
  for (const player of room.players) {
    io.to(player.id).emit('state', room.toClientState(player.id));
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const code = genRoomCode();
    const room = new Room(code, socket.id);
    room.addPlayer(socket.id, (name || '名無し').slice(0, 12));
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    broadcastState(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
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
    room.addPlayer(socket.id, (name || '名無し').slice(0, 12));
    socket.join(room.code);
    socket.data.roomCode = room.code;
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) {
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
    const result = room.rollDice(socket.id);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('chooseHandSize', ({ size }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const result = room.chooseHandSize(socket.id, size);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('dosun', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.dosun(socket.id);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('playCard', ({ cardId, chosenSuit }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.playCard(socket.id, cardId, chosenSuit);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('ron', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.ron(socket.id);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('declarePageOne', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.declarePageOne(socket.id);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('drawCard', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.draw(socket.id);
    if (result.error) {
      socket.emit('errorMsg', result.error);
      return;
    }
    broadcastState(room);
  });

  socket.on('endTurn', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const result = room.endTurn(socket.id);
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
  room.removePlayer(socket.id);
  socket.data.roomCode = null;
  const stillConnected = room.players.some((p) => p.connected);
  if (!stillConnected) {
    rooms.delete(code);
    return;
  }
  broadcastState(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO online server running on http://localhost:${PORT}`);
});
