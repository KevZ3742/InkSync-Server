const { createServer } = require('http');
const { Server } = require('socket.io');

const rooms = new Map();
const socketToRoom = new Map();
const disconnectTimers = new Map();
const roomCleanupTimers = new Map();

const MAX_CHAT_HISTORY = 100;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours after everyone leaves
const USER_DISCONNECT_GRACE_MS = 30 * 1000; // 30s grace for reconnects

function getOrCreateRoom(code) {
  // If a cleanup was scheduled for this room, cancel it — someone rejoined
  if (roomCleanupTimers.has(code)) {
    clearTimeout(roomCleanupTimers.get(code));
    roomCleanupTimers.delete(code);
    console.log(`Room ${code} cleanup cancelled — user rejoined`);
  }

  if (!rooms.has(code)) {
    rooms.set(code, { elements: [], users: new Map(), chatMessages: [] });
  }
  return rooms.get(code);
}

function scheduleRoomCleanup(roomCode) {
  if (roomCleanupTimers.has(roomCode)) return; // already scheduled

  console.log(`Room ${roomCode} is empty, scheduling cleanup in 24h`);
  const timer = setTimeout(() => {
    rooms.delete(roomCode);
    roomCleanupTimers.delete(roomCode);
    console.log(`Room ${roomCode} deleted after TTL`);
  }, ROOM_TTL_MS);

  roomCleanupTimers.set(roomCode, timer);
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

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(200);
  res.end('ink-sync socket server');
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const io = new Server(httpServer, {
  cors: {
    origin: [FRONTEND_URL, 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

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

  socket.on('chat-message', ({ message }) => {
    const info = socketToRoom.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const user = room.users.get(info.userId);
    if (!user) return;

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

  socket.on('disconnect', () => {
    const info = socketToRoom.get(socket.id);
    socketToRoom.delete(socket.id);
    if (!info) return;

    const { roomCode, userId } = info;

    // Short grace period for reconnects (tab refresh, brief network blip)
    const timer = setTimeout(() => {
      disconnectTimers.delete(userId);

      const room = rooms.get(roomCode);
      if (!room) return;

      const stillConnected = Array.from(socketToRoom.values())
        .some(s => s.roomCode === roomCode && s.userId === userId);

      if (!stillConnected) {
        room.users.delete(userId);
        io.to(roomCode).emit('user-left', { userId });

        // If the room is now empty, schedule cleanup after 24h.
        // This keeps the canvas alive for accidental closes / Render restarts
        // but eventually frees memory for abandoned rooms.
        if (room.users.size === 0) {
          scheduleRoomCleanup(roomCode);
        }
      }
    }, USER_DISCONNECT_GRACE_MS);

    disconnectTimers.set(userId, timer);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`ink-sync socket server running on port ${PORT}`);
  console.log(`Allowing CORS from: ${FRONTEND_URL}`);

  // Keep-alive ping to prevent Render free tier from spinning down.
  // Render only resets its inactivity timer on HTTP requests, not WebSocket
  // traffic, so we self-ping /health every 10 minutes to stay awake.
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    console.log(`Keep-alive enabled, pinging ${RENDER_URL}/health every 10 minutes`);
    setInterval(() => {
      fetch(`${RENDER_URL}/health`)
        .then(() => console.log('keep-alive ping sent'))
        .catch(err => console.error('keep-alive ping failed:', err));
    }, 10 * 60 * 1000);
  }
});