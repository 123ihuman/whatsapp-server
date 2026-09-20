// Force IPv4 globally — Render free tier doesn't support IPv6
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

// Firebase Admin — modular API
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (serviceAccount.project_id) {
        initializeApp({ credential: cert(serviceAccount) });
        console.log('✅ Firebase Admin ready');
    } else {
        console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT missing in .env — push disabled');
    }
} catch (e) {
    console.warn('⚠️ Firebase Admin init failed:', e.message);
}
const nodemailer = require('nodemailer');

// Gmail SMTP transporter — uses App Password (not your Gmail password)
const mailer = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    family: 4,                  // ← force IPv4 (Render doesn't support IPv6)
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
    }
});

mailer.verify().then(() => {
    console.log('✅ Gmail SMTP ready');
}).catch(err => {
    console.warn('⚠️ Gmail SMTP not ready:', err.message);
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = '399508571725-ooqfl87744gc5gln645vid2u7jnmbd9r.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET missing in .env');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ---------- MONGO ----------
const MONGO_URI = process.env.MONGO_URI;

mongoose.set('bufferCommands', false);   // fail fast instead of waiting 10s

let mongoReady = false;
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10
})
    .then(() => { mongoReady = true; console.log('Connected to MongoDB Atlas'); })
    .catch(err => console.error('MongoDB error:', err.message));

// Gate every API request until Mongo is ready
app.use('/api', (req, res, next) => {
    if (!mongoReady) return res.status(503).json({ error: 'Database not ready, retry in 5s' });
    next();
});
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
    viewOnce:  { type: Boolean, default: false },
    replyTo:   { type: mongoose.Schema.Types.Mixed, default: null },
    reactions: { type: mongoose.Schema.Types.Mixed, default: {} },
    edited:    { type: Boolean, default: false },
    forwarded: { type: Boolean, default: false },
    read:      { type: Boolean, default: false },
    deleted:   { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null, index: { expires: 0 } }
});
const Message = mongoose.model('Message', messageSchema);

const userPrefsSchema = new mongoose.Schema({
    userId:  { type: String, required: true, unique: true },
    pinned:  { type: [String], default: [] },
    archived:{ type: [String], default: [] },
    starred: { type: [String], default: [] },
    blocked: { type: [String], default: [] },
    privacy: { type: mongoose.Schema.Types.Mixed, default: {} }
});
const UserPrefs = mongoose.model('UserPrefs', userPrefsSchema);

const groupSchema = new mongoose.Schema({
    groupId:   { type: String, required: true, unique: true },
    name:      { type: String, required: true },
    icon:      { type: String, default: null },
    members:   { type: [String], default: [] },
    admins:    { type: [String], default: [] },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Group = mongoose.model('Group', groupSchema);

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
const userSchema = new mongoose.Schema({
    identifier:  { type: String, required: true, unique: true },
    name:        { type: String, required: true },
    password:    { type: String, required: true },
    avatarUrl:   { type: String, default: null },
    fcmToken:    { type: String, default: null },
    backupEmail: { type: String, default: null },
    otpHash:     { type: String, default: null },
    otpExpiry:   { type: Date,   default: null },
    otpAttempts: { type: Number, default: 0 },
    lastSeen:    { type: Date, default: Date.now },
    createdAt:   { type: Date, default: Date.now }
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

app.post('/api/messages/setDisappearing', async (req, res) => {
  try {
    const { roomId, seconds } = req.body;
    const cutoff = seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
    await Message.updateMany({ roomId, expiresAt: null }, { $set: { expiresAt: cutoff } });
    io.to(roomId).emit('disappearingUpdated', { roomId, seconds });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/react', async (req, res) => {
  try {
    const { msgId, userId, emoji } = req.body;
    const msg = await Message.findById(msgId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const r = { ...(msg.reactions || {}) };
    if (r[userId] === emoji) delete r[userId]; else r[userId] = emoji;
    msg.reactions = r; await msg.save();
    io.to(msg.roomId).emit('messageReacted', { msgId: msg._id, roomId: msg.roomId, reactions: r });
    res.json({ ok: true, reactions: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/edit', async (req, res) => {
  try {
    const { msgId, userId, text } = req.body;
    const msg = await Message.findById(msgId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.sender !== userId) return res.status(403).json({ error: 'Not yours' });
    msg.text = text; msg.edited = true; await msg.save();
    io.to(msg.roomId).emit('messageEdited', { msgId: msg._id, roomId: msg.roomId, text });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/forward', async (req, res) => {
  try {
    const { msgId, targetRoomId, userId, senderName } = req.body;
    const src = await Message.findById(msgId);
    if (!src) return res.status(404).json({ error: 'Not found' });
    const m = await Message.create({ roomId: targetRoomId, sender: userId, senderName, text: src.text, mediaUrl: src.mediaUrl, mediaType: src.mediaType, forwarded: true });
    io.to(targetRoomId).emit('newMessage', m);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

app.get('/api/prefs/:userId', async (req, res) => {
  try { let p = await UserPrefs.findOne({ userId: req.params.userId }); if (!p) p = await UserPrefs.create({ userId: req.params.userId }); res.json(p); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/starred/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const prefs = await UserPrefs.findOne({ userId: uid });
    if (!prefs || !prefs.starred || prefs.starred.length === 0) return res.json([]);
    const msgs = await Message.find({ roomId: { $in: prefs.starred }, deleted: false }).sort({ createdAt: -1 }).limit(200);
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/unblock', async (req, res) => {
  try {
    const { userId, targetId } = req.body;
    await UserPrefs.updateOne({ userId }, { $pull: { blocked: targetId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/prefs/:userId', async (req, res) => {
  try { const { field, value } = req.body; const upd = {}; upd[field] = value;
    await UserPrefs.findOneAndUpdate({ userId: req.params.userId }, { $set: upd }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- AUTH ROUTES ----------
app.post('/api/signup', async (req, res) => {
    try {
        const { identifier, name, password, backupEmail } = req.body;
        if (!identifier || !name || !password) return res.status(400).json({ error: 'Missing fields' });
        const existing = await User.findOne({ identifier });
        if (existing) return res.status(400).json({ error: 'User already exists' });
        const hashed = await bcrypt.hash(password, 10);
        const user = await User.create({
            identifier,
            name,
            password: hashed,
            backupEmail: backupEmail || null
        });
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

// ---------- OTP PASSWORD RESET ----------
const OTP_TTL_MS = 10 * 60 * 1000;
// ... (first block: generateOtp, maskEmail, both routes) ...
app.post('/api/forgot-password/verify', async (req, res) => {
    // ... first verify handler ...
});

app.post('/api/login', async (req, res) => {
    try {
        const { identifier } = req.body;
        if (!identifier) return res.status(400).json({ error: 'Missing identifier' });

        const user = await User.findOne({ identifier });
        // Do not leak whether the account exists
        if (!user) return res.json({ ok: true, sentTo: null, generic: true });

        if (!user.backupEmail) {
            return res.status(400).json({ error: 'No backup email on file for this account' });
        }

        // Rate limit
        const lastSent = lastOtpSentAt.get(String(user._id)) || 0;
        if (Date.now() - lastSent < OTP_RATE_WINDOW) {
            const wait = Math.ceil((OTP_RATE_WINDOW - (Date.now() - lastSent)) / 1000);
            return res.status(429).json({ error: 'Please wait ' + wait + 's before requesting a new code' });
        }

        const otp = generateOtp();
        user.otpHash = await bcrypt.hash(otp, 10);
        user.otpExpiry = new Date(Date.now() + OTP_TTL_MS);
        user.otpAttempts = 0;
        await user.save();
        lastOtpSentAt.set(String(user._id), Date.now());

        const mail = {
            from: '"WhatsApp Clone" <' + process.env.GMAIL_USER + '>',
            to: user.backupEmail,
            subject: 'Your password reset code',
            text:
                'Hi ' + user.name + ',\n\n' +
                'Your password reset code is: ' + otp + '\n\n' +
                'This code expires in 10 minutes. If you did not request a password reset, you can safely ignore this email.\n\n' +
                '— WhatsApp Clone',
            html:
                '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
                '<h2 style="color:#111b21;">Password reset</h2>' +
                '<p style="color:#667781;">Hi ' + user.name + ',</p>' +
                '<p style="color:#667781;">Use the code below to reset your password. It expires in <b>10 minutes</b>.</p>' +
                '<div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#e7fce3;color:#008069;padding:18px;text-align:center;border-radius:12px;margin:20px 0;">' + otp + '</div>' +
                '<p style="color:#8696a0;font-size:13px;">If you did not request this, ignore this email.</p>' +
                '</div>'
        };

        await mailer.sendMail(mail);
        res.json({ ok: true, sentTo: maskEmail(user.backupEmail) });
    } catch (err) {
        console.error('OTP request failed:', err);
        res.status(500).json({ error: 'Could not send code. Try again later.' });
    }
});

// Step 2: Verify OTP + set new password
app.post('/api/forgot-password/verify', async (req, res) => {
    try {
        const { identifier, otp, newPassword } = req.body;
        if (!identifier || !otp || !newPassword) return res.status(400).json({ error: 'Missing fields' });
        if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });

        const user = await User.findOne({ identifier });
        if (!user) return res.status(400).json({ error: 'Invalid code' });
        if (!user.otpHash || !user.otpExpiry) return res.status(400).json({ error: 'No code requested' });
        if (user.otpExpiry.getTime() < Date.now()) return res.status(400).json({ error: 'Code expired — request a new one' });
        if (user.otpAttempts >= OTP_MAX_ATTEMPTS) return res.status(400).json({ error: 'Too many attempts — request a new code' });

        const ok = await bcrypt.compare(String(otp).trim(), user.otpHash);
        if (!ok) {
            user.otpAttempts = (user.otpAttempts || 0) + 1;
            await user.save();
            return res.status(400).json({ error: 'Invalid code' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.otpHash = null;
        user.otpExpiry = null;
        user.otpAttempts = 0;
        await user.save();

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- OTP PASSWORD RESET ----------

app.post('/api/forgot-password/request', async (req, res) => {
    try {
        const { identifier } = req.body;
        if (!identifier) return res.status(400).json({ error: 'Missing identifier' });

        const user = await User.findOne({ identifier });
        if (!user) return res.json({ ok: true, sentTo: null, generic: true });

        if (!user.backupEmail) {
            return res.status(400).json({ error: 'No backup email on file for this account' });
        }

        const lastSent = lastOtpSentAt.get(String(user._id)) || 0;
        if (Date.now() - lastSent < OTP_RATE_WINDOW) {
            const wait = Math.ceil((OTP_RATE_WINDOW - (Date.now() - lastSent)) / 1000);
            return res.status(429).json({ error: 'Please wait ' + wait + 's before requesting a new code' });
        }

        const otp = generateOtp();
        user.otpHash = await bcrypt.hash(otp, 10);
        user.otpExpiry = new Date(Date.now() + OTP_TTL_MS);
        user.otpAttempts = 0;
        await user.save();
        lastOtpSentAt.set(String(user._id), Date.now());

        await mailer.sendMail({
            from: '"WhatsApp Clone" <' + process.env.GMAIL_USER + '>',
            to: user.backupEmail,
            subject: 'Your password reset code',
            text:
                'Hi ' + user.name + ',\n\n' +
                'Your password reset code is: ' + otp + '\n\n' +
                'This code expires in 10 minutes. If you did not request this, ignore this email.\n\n' +
                '— WhatsApp Clone',
            html:
                '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
                '<h2 style="color:#111b21;">Password reset</h2>' +
                '<p style="color:#667781;">Hi ' + user.name + ',</p>' +
                '<p style="color:#667781;">Use the code below to reset your password. Expires in <b>10 minutes</b>.</p>' +
                '<div style="font-size:32px;font-weight:700;letter-spacing:6px;background:#e7fce3;color:#008069;padding:18px;text-align:center;border-radius:12px;margin:20px 0;">' + otp + '</div>' +
                '<p style="color:#8696a0;font-size:13px;">If you did not request this, ignore this email.</p>' +
                '</div>'
        });

        res.json({ ok: true, sentTo: maskEmail(user.backupEmail) });
    } catch (err) {
        console.error('OTP request failed:', err);
        res.status(500).json({ error: 'Could not send code. Try again later.' });
    }
});

app.post('/api/forgot-password/verify', async (req, res) => {
    try {
        const { identifier, otp, newPassword } = req.body;
        if (!identifier || !otp || !newPassword) return res.status(400).json({ error: 'Missing fields' });
        if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short' });

        const user = await User.findOne({ identifier });
        if (!user) return res.status(400).json({ error: 'Invalid code' });
        if (!user.otpHash || !user.otpExpiry) return res.status(400).json({ error: 'No code requested' });
        if (user.otpExpiry.getTime() < Date.now()) return res.status(400).json({ error: 'Code expired — request a new one' });
        if (user.otpAttempts >= OTP_MAX_ATTEMPTS) return res.status(400).json({ error: 'Too many attempts — request a new code' });

        const ok = await bcrypt.compare(String(otp).trim(), user.otpHash);
        if (!ok) {
            user.otpAttempts = (user.otpAttempts || 0) + 1;
            await user.save();
            return res.status(400).json({ error: 'Invalid code' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.otpHash = null;
        user.otpExpiry = null;
        user.otpAttempts = 0;
        await user.save();

        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

app.get('/api/blocked/:userId', async (req, res) => {
  try { const p = await UserPrefs.findOne({ userId: req.params.userId }); res.json(p ? p.blocked : []); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- FCM TOKEN ----------
app.post('/api/fcm-token', async (req, res) => {
    try {
        const { userId, token } = req.body;
        if (!userId || !token) return res.status(400).json({ error: 'Missing fields' });
        await User.findByIdAndUpdate(userId, { fcmToken: token });
        console.log('✅ FCM token saved for user', userId);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', async (req, res) => {
    try {
        const list = await User.find({}, { password: 0 }).sort({ name: 1 }).lean();
        const allPrefs = await UserPrefs.find({ userId: { $in: list.map(u => String(u._id)) } }).lean();
        const prefsMap = {};
        allPrefs.forEach(p => { prefsMap[p.userId] = p; });

        const out = list.map(u => {
            const p = prefsMap[String(u._id)] || {};
            const privacy = p.privacy || {};
            const hideLastSeen   = privacy.lastSeen === 'nobody';
            const hidePhoto      = privacy.profilePhoto === 'nobody';
            const hideAbout      = privacy.about === 'nobody';
            return {
                _id: u._id,
                identifier: u.identifier,
                name: u.name,
                avatarUrl: hidePhoto ? null : u.avatarUrl,
                about:     hideAbout ? null : (u.about || null),
                lastSeen:  hideLastSeen ? null : u.lastSeen,
                hideLastSeen,
                hidePhoto,
                hideAbout
            };
        });
        res.json(out);
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

app.post('/api/groups', async (req, res) => {
  try {
    const { name, members, createdBy } = req.body;
    if (!name || !createdBy) return res.status(400).json({ error: 'Missing fields' });
    const gid = 'group_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const g = await Group.create({
      groupId: gid,
      name,
      members: [createdBy, ...(members || [])],
      admins:  [createdBy],
      createdBy
    });
    io.emit('groupCreated', { groupId: gid, name, members: g.members, admins: g.admins });
    res.json(g);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:userId', async (req, res) => {
  try { const list = await Group.find({ members: req.params.userId }); res.json(list); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/info/:groupId', async (req, res) => {
  try { const g = await Group.findOne({ groupId: req.params.groupId }); res.json(g || {}); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/addMember', async (req, res) => {
  try {
    const { groupId, userId, requesterId } = req.body;
    const g = await Group.findOne({ groupId });
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!g.admins.includes(requesterId)) return res.status(403).json({ error: 'Only admins can add members' });
    await Group.updateOne({ groupId }, { $addToSet: { members: userId } });
    io.emit('groupUpdated', { groupId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/removeMember', async (req, res) => {
  try {
    const { groupId, userId, requesterId } = req.body;
    const g = await Group.findOne({ groupId });
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!g.admins.includes(requesterId)) return res.status(403).json({ error: 'Only admins can remove members' });
    await Group.updateOne({ groupId }, { $pull: { members: userId, admins: userId } });
    io.emit('groupUpdated', { groupId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/leave', async (req, res) => {
  try {
    const { groupId, userId } = req.body;
    const g = await Group.findOne({ groupId });
    if (!g) return res.status(404).json({ error: 'Group not found' });
    await Group.updateOne({ groupId }, { $pull: { members: userId, admins: userId } });
    const updated = await Group.findOne({ groupId });
    if (updated && updated.members.length > 0 && updated.admins.length === 0) {
      await Group.updateOne({ groupId }, { $set: { admins: [updated.members[0]] } });
    }
    io.emit('groupUpdated', { groupId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/rename', async (req, res) => {
  try {
    const { groupId, name, requesterId } = req.body;
    const g = await Group.findOne({ groupId });
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!g.admins.includes(requesterId)) return res.status(403).json({ error: 'Only admins can rename' });
    await Group.updateOne({ groupId }, { $set: { name } });
    io.emit('groupUpdated', { groupId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/setIcon', async (req, res) => {
  try {
    const { groupId, iconUrl, requesterId } = req.body;
    const g = await Group.findOne({ groupId });
    if (!g) return res.status(404).json({ error: 'Group not found' });
    if (!g.admins.includes(requesterId)) return res.status(403).json({ error: 'Only admins can change icon' });
    await Group.updateOne({ groupId }, { $set: { icon: iconUrl } });
    io.emit('groupUpdated', { groupId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- QR LOGIN ----------
const qrSessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, expires: 120 }
});
const QrSession = mongoose.model('QrSession', qrSessionSchema);

app.post('/api/qr/generate', async (req, res) => {
    try {
        const sessionId = crypto.randomBytes(32).toString('hex');
        await QrSession.create({ sessionId });
        res.json({ sessionId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/qr/scan', async (req, res) => {
    try {
        const { sessionId, userId } = req.body;
        const session = await QrSession.findOne({ sessionId });
        if (!session) return res.status(400).json({ error: 'Invalid or expired QR code' });
        const user = await User.findById(userId);
        if (!user) return res.status(400).json({ error: 'User not found' });
        const token = jwt.sign({ id: user._id, name: user.name, identifier: user.identifier }, JWT_SECRET, { expiresIn: '30d' });
        io.to(sessionId).emit('qr-login-success', {
            id: user._id, name: user.name, identifier: user.identifier,
            avatarUrl: user.avatarUrl, token
        });
        await QrSession.deleteOne({ sessionId });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- SOCKET.IO ----------
const onlineUsers = new Map();

async function broadcastOnline() {
    const uniqueUserIds = [...new Set(onlineUsers.values())];
    try {
        const hidden = await UserPrefs.find({
            userId: { $in: uniqueUserIds },
            'privacy.lastSeen': 'nobody'
        }).select('userId').lean();
        const hiddenSet = new Set(hidden.map(p => p.userId));
        io.emit('onlineUsers', uniqueUserIds.filter(id => !hiddenSet.has(id)));
    } catch(e) {
        io.emit('onlineUsers', uniqueUserIds);
    }
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('userOnline', (userId) => {
        onlineUsers.set(socket.id, userId);
        broadcastOnline();
    });

    socket.on('join-qr-session', (sessionId) => {
        socket.join(sessionId);
        console.log(`Desktop waiting for QR session: ${sessionId}`);
    });

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        socket.to(roomId).emit('userJoined', socket.id);
    });

    socket.on('offer', (d) => socket.to(d.roomId).emit('offer', d));
    socket.on('callType', (d) => socket.to(d.roomId).emit('callType', d));
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
                viewOnce:  data.viewOnce || false,
                replyTo:   data.replyTo || null,
                expiresAt: data.expiresAt || null
            });
            io.to(data.roomId).emit('newMessage', msg);

            // ---- PUSH if recipient(s) offline ----
            try {
                // roomId format: "userA_userB" — split to find recipient
                const parts = String(data.roomId).split('_');
                const recipientId = parts.find(p => p !== data.sender);
                if (recipientId){
                    const stillOnline = [...onlineUsers.values()].includes(recipientId);
                    if (!stillOnline){
                        const recipient = await User.findById(recipientId).select('fcmToken name');
                        if (recipient && recipient.fcmToken){
                            await getMessaging().send({
    token: recipient.fcmToken,
    notification: {
        title: data.senderName || 'New message',
        body:  data.text || (data.mediaType ? '(' + data.mediaType + ')' : 'New message')
    },
    data: { roomId: String(data.roomId), senderId: String(data.sender) }
});
                        }
                    }
                }
            } catch (pushErr){ console.warn('FCM send failed:', pushErr.message); }
        } catch (err) {
            console.error('Message save error:', err);
        }
    });

    socket.on('joinChat', (roomId) => {
        socket.join(roomId);
        console.log(`${socket.id} joined chat ${roomId}`);
    });

    socket.on('disconnect', async () => {
        console.log('User disconnected:', socket.id);
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));