const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = '399508571725-ooqfl87744gc5gln645vid2u7jnmbd9r.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production-9a8b7c6d';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---------- MONGO ----------
const MONGO_URI = "mongodb://umadivy500_db_user:Test12345@ac-dn2ahhy-shard-00-00.df7ih5q.mongodb.net:27017,ac-dn2ahhy-shard-00-01.df7ih5q.mongodb.net:27017,ac-dn2ahhy-shard-00-02.df7ih5q.mongodb.net:27017/whatsapp?ssl=true&replicaSet=atlas-13eq8a-shard-0&authSource=admin&retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB error:', err.message));

// Status schema — auto-deletes after 24h via TTL index
const statusSchema = new mongoose.Schema({
    userId:   { type: String, required: true },
    userName: { type: String, required: true },
    mediaUrl: { type: String, required: true },
    mediaType:{ type: String, enum: ['image', 'video'], required: true },
    createdAt:{ type: Date, default: Date.now, expires: 86400 }
});
const Status = mongoose.model('Status', statusSchema);
// Message schema
const messageSchema = new mongoose.Schema({
    roomId:    { type: String, required: true },
    sender:    { type: String, required: true },
    senderName:{ type: String, required: true },
    text:      { type: String, default: '' },
    mediaUrl:  { type: String, default: null },
    mediaType: { type: String, default: null },
    replyTo:   { type: mongoose.Schema.Types.Mixed, default: null },
    read:      { type: Boolean, default: false },
    deleted:   { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);
// Call schema — call history
const callSchema = new mongoose.Schema({
    callerId:     { type: String, required: true },
    callerName:   { type: String, required: true },
    receiverId:   { type: String, required: true },
    receiverName: { type: String, required: true },
    type:         { type: String, enum: ['audio', 'video'], required: true },
    direction:    { type: String, enum: ['outgoing', 'incoming', 'missed'], required: true },
    createdAt:    { type: Date, default: Date.now }
});
const Call = mongoose.model('Call', callSchema);
// User schema
const userSchema = new mongoose.Schema({
    identifier: { type: String, required: true, unique: true },
    name:       { type: String, required: true },
    password:   { type: String, required: true },
    avatarUrl:  { type: String, default: null },
    lastSeen:   { type: Date, default: Date.now },
    createdAt:  { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ---------- FILE UPLOADS ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.bin';
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- MIDDLEWARE ----------
app.use(express.json());
app.use(express.static('public'));

// ---------- STATUS ROUTES ----------
app.post('/api/status', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const { userId, userName, mediaType } = req.body;
        if (!userId || !userName || !mediaType) return res.status(400).json({ error: 'Missing fields' });

        const status = await Status.create({
            userId,
            userName,
            mediaType,
            mediaUrl: `/uploads/${req.file.filename}`
        });
        io.emit('newStatus', status);
        res.json(status);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        const list = await Status.find().sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- MESSAGE MEDIA UPLOAD ----------
app.post('/api/message-media', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        res.json({ url: `/uploads/${req.file.filename}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- MESSAGE ROUTES ----------
// Get messages for a room
app.get('/api/messages/:roomId', async (req, res) => {
    try {
        const list = await Message.find({ roomId: req.params.roomId })
                                 .sort({ createdAt: 1 })
                                 .limit(200);
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/messages/read', async (req, res) => {
    try {
        const { roomId, userId } = req.body;
        await Message.updateMany(
            { roomId, sender: { $ne: userId }, read: false },
            { $set: { read: true } }
        );
        io.to(roomId).emit('messagesRead', { roomId });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages/clear', async (req, res) => { try { await Message.deleteMany({ roomId: req.body.roomId }); io.to(req.body.roomId).emit('chatCleared', { roomId: req.body.roomId }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/messages/deleteRoom', async (req, res) => { try { await Message.deleteMany({ roomId: req.body.roomId }); io.to(req.body.roomId).emit('chatCleared', { roomId: req.body.roomId }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/messages/delete', async (req, res) => {
    try {
        const { msgId, userId } = req.body;
        const msg = await Message.findById(msgId);
        if (!msg) return res.status(404).json({ error: 'Not found' });
        if (msg.sender !== userId) return res.status(403).json({ error: 'Not your message' });
        msg.deleted = true;
        msg.text = '';
        msg.mediaUrl = null;
        msg.mediaType = null;
        msg.replyTo = null;
        await msg.save();
        io.to(msg.roomId).emit('messageDeleted', { msgId: msg._id, roomId: msg.roomId });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/unread/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const msgs = await Message.aggregate([
      { $match: { read: false, sender: { $ne: uid }, deleted: false } },
      { $group: { _id: '$roomId', count: { $sum: 1 } } }
    ]);
    const rooms = {}; let total = 0;
    for (const m of msgs) { if (m._id.includes(uid)) { rooms[m._id] = m.count; total += m.count; } }
    res.json({ rooms, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---------- AUTH ROUTES ----------
app.post('/api/signup', async (req, res) => {
    try {
        const { identifier, name, password } = req.body;
        if (!identifier || !name || !password) return res.status(400).json({ error: 'Missing fields' });
        const existing = await User.findOne({ identifier });
        if (existing) return res.status(400).json({ error: 'User already exists' });
        const hashed = await bcrypt.hash(password, 10);
        const user = await User.create({ identifier, name, password: hashed });
        const token = jwt.sign({ id: user._id, name: user.name, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user._id, name: user.name, identifier: user.identifier } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/google-login', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const identifier = payload.email;
    const name = payload.name || payload.email.split('@')[0];
    const picture = payload.picture || null;
    let user = await User.findOne({ identifier });
    if (!user) {
      const hashed = await bcrypt.hash('google_' + payload.sub + '_' + Date.now(), 10);
      user = await User.create({ identifier, name, password: hashed, avatarUrl: picture });
    } else if (picture && !user.avatarUrl) {
      user.avatarUrl = picture;
      await user.save();
    }
    const token = jwt.sign({ id: user._id, name: user.name, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, name: user.name, identifier: user.identifier, avatarUrl: user.avatarUrl } });
  } catch (err) { console.error('Google login error:', err); res.status(401).json({ error: 'Invalid Google token' }); }
});
app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (!identifier || !password) return res.status(400).json({ error: 'Missing fields' });
        const user = await User.findOne({ identifier });
        if (!user) return res.status(400).json({ error: 'User not found' });
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return res.status(400).json({ error: 'Wrong password' });
        const token = jwt.sign({ id: user._id, name: user.name, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user._id, name: user.name, identifier: user.identifier } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List all users (for contacts) — excludes passwords
app.get('/api/users', async (req, res) => {
    try {
        const list = await User.find({}, { password: 0 }).sort({ name: 1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ---------- AVATAR UPLOAD ----------
app.post('/api/avatar', upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const { userId } = req.body;
        const url = `/uploads/${req.file.filename}`;
        await User.findByIdAndUpdate(userId, { avatarUrl: url });
        io.emit('userAvatarUpdated', { userId, avatarUrl: url });
        res.json({ avatarUrl: url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ---------- CALL ROUTES ----------
app.post('/api/calls', async (req, res) => {
    try {
        const { callerId, callerName, receiverId, receiverName, type, direction } = req.body;
        const call = await Call.create({ callerId, callerName, receiverId, receiverName, type, direction });
        io.emit('newCallLogged', { receiverId, callerId });
        res.json(call);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/calls/:userId', async (req, res) => {
    try {
        const uid = req.params.userId;
        const list = await Call.find({
            $or: [{ callerId: uid }, { receiverId: uid }]
        }).sort({ createdAt: -1 }).limit(100);
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ---------- SOCKET.IO ----------
const onlineUsers = new Map(); // socketId -> userId

function broadcastOnline() {
    const uniqueUserIds = [...new Set(onlineUsers.values())];
    io.emit('onlineUsers', uniqueUserIds);
}

io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    socket.on('userOnline', (userId) => {
        onlineUsers.set(socket.id, userId);
        broadcastOnline();
    });

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        socket.to(roomId).emit('userJoined', socket.id);
    });
    socket.on('offer', (d) => socket.to(d.roomId).emit('offer', d));
    socket.on('answer', (d) => socket.to(d.roomId).emit('answer', d));
    socket.on('iceCandidate', (d) => socket.to(d.roomId).emit('iceCandidate', d));
    socket.on('endCall', (d) => socket.to(d.roomId).emit('endCall'));
    socket.on('typing', (data) => {
        socket.to(data.roomId).emit('typing', { from: data.senderName });
    });

           socket.on('sendMessage', async (data) => {
        try {
            const msg = await Message.create({
                roomId:    data.roomId,
                sender:    data.sender,
                senderName:data.senderName,
                text:      data.text || '',
                mediaUrl:  data.mediaUrl || null,
                mediaType: data.mediaType || null,
                replyTo:   data.replyTo || null
            });
            io.to(data.roomId).emit('newMessage', msg);
        } catch (err) {
            console.error('Message save error:', err);
        }
    });

    socket.on('joinChat', (roomId) => {
        socket.join(roomId);
        console.log(`📥 ${socket.id} joined chat ${roomId}`);
    });

    socket.on('disconnect', async () => {
        console.log('❌ User disconnected:', socket.id);
        const userId = onlineUsers.get(socket.id);
        if (userId) {
            onlineUsers.delete(socket.id);
            const stillOnline = [...onlineUsers.values()].includes(userId);
            if (!stillOnline) {
                try { await User.findByIdAndUpdate(userId, { lastSeen: new Date() }); } catch (e) {}
            }
            broadcastOnline();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));