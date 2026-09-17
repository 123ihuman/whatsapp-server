const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        socket.to(roomId).emit('userJoined', socket.id);
    });
    socket.on('offer', (d) => socket.to(d.roomId).emit('offer', d));
    socket.on('answer', (d) => socket.to(d.roomId).emit('answer', d));
    socket.on('iceCandidate', (d) => socket.to(d.roomId).emit('iceCandidate', d));
    socket.on('endCall', (d) => socket.to(d.roomId).emit('endCall'));

    socket.on('disconnect', () => console.log('❌ User disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));