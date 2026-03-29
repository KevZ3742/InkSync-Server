const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const rooms = new Map();
const socketToRoom = new Map();
const disconnectTimers = new Map();

const MAX_CHAT_HISTORY = 100;

function getOrCreateRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { elements: [], users: new Map(), chatMessages: [] });
  }
  return rooms.get(code);
}

function randomColor(seed) {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#82E0AA', '#F0B27A',
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const io = new Server(httpServer);

  io.on('connection', (socket) => {

    socket.on('join-room', ({ roomCode, userName, userId }) => {
      if (disconnectTimers.has(userId)) {
        clearTimeout(disconnectTimers.get(userId));
        disconnectTimers.delete(userId);
      }

      const room = getOrCreateRoom(roomCode);
      const user = { id: userId, name: userName, color: randomColor(userId) };
      room.users.set(userId, user);
      socketToRoom.set(socket.id, { roomCode, userId });

      socket.join(roomCode);

      socket.emit('room-state', {
        elements: room.elements,
        users: Array.from(room.users.values()),
        chatMessages: room.chatMessages,
      });

      socket.to(roomCode).emit('user-joined', user);
    });

    socket.on('draw-elements', ({ elements }) => {
      const info = socketToRoom.get(socket.id);
      if (!info) return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      room.elements = elements;
      socket.to(info.roomCode).emit('draw-elements', { elements });
    });

    socket.on('cursor-move', ({ x, y }) => {
      const info = socketToRoom.get(socket.id);
      if (!info) return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      const user = room.users.get(info.userId);
      if (!user) return;
      socket.to(info.roomCode).emit('cursor-move', {
        userId: user.id, name: user.name, color: user.color, x, y,
      });
    });

    socket.on('cursor-leave', () => {
      const info = socketToRoom.get(socket.id);
      if (!info) return;
      socket.to(info.roomCode).emit('cursor-leave', { userId: info.userId });
    });

    // ── Chat ────────────────────────────────────────────────────────────────

    socket.on('chat-message', ({ message }) => {
      const info = socketToRoom.get(socket.id);
      if (!info) return;
      const room = rooms.get(info.roomCode);
      if (!room) return;
      const user = room.users.get(info.userId);
      if (!user) return;

      // Sanitize and cap length
      const text = String(message.text ?? '').trim().slice(0, 500);
      if (!text) return;

      const msg = {
        id: message.id,
        userId: user.id,
        userName: user.name,
        userColor: user.color,
        text,
        timestamp: Date.now(),
        reactions: {},
      };

      room.chatMessages.push(msg);
      if (room.chatMessages.length > MAX_CHAT_HISTORY) {
        room.chatMessages = room.chatMessages.slice(-MAX_CHAT_HISTORY);
      }

      io.to(info.roomCode).emit('chat-message', { message: msg });
    });

    socket.on('chat-reaction', ({ messageId, emoji }) => {
      const info = socketToRoom.get(socket.id);
      if (!info) return;
      const room = rooms.get(info.roomCode);
      if (!room) return;

      const msg = room.chatMessages.find(m => m.id === messageId);
      if (!msg) return;

      if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

      const idx = msg.reactions[emoji].indexOf(info.userId);
      if (idx >= 0) {
        // Toggle off
        msg.reactions[emoji].splice(idx, 1);
      } else {
        msg.reactions[emoji].push(info.userId);
      }

      io.to(info.roomCode).emit('chat-reaction', {
        messageId,
        emoji,
        reactions: msg.reactions,
      });
    });

    // ── Disconnect ──────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      const info = socketToRoom.get(socket.id);
      socketToRoom.delete(socket.id);
      if (!info) return;

      const { roomCode, userId } = info;

      const timer = setTimeout(() => {
        disconnectTimers.delete(userId);

        const room = rooms.get(roomCode);
        if (!room) return;

        const stillConnected = Array.from(socketToRoom.values())
          .some(s => s.roomCode === roomCode && s.userId === userId);

        if (!stillConnected) {
          room.users.delete(userId);
          io.to(roomCode).emit('user-left', { userId });
          if (room.users.size === 0) rooms.delete(roomCode);
        }
      }, 3000);

      disconnectTimers.set(userId, timer);
    });
  });

  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`> Ink Sync running on http://localhost:${PORT}`);
  });
});