const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const EventEmitter = require('events');
const baileysEmitter = new EventEmitter();

let sock = null;
let isReady = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

        sock = makeWASocket({
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: true // 👈 THIS IS THE MAGIC LINE
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 SCAN THIS QR WITH WHATSAPP ON YOUR PHONE:\n');
            qrcode.generate(qr, { small: true });
            console.log('\nWhatsApp → Settings → Linked Devices → Link a Device\n');
        }

        if (connection === 'close') {
            isReady = false;
            const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log('Baileys closed. Reason code:', code, '— reconnect?', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            isReady = true;
            console.log('✅ Baileys WhatsApp connected\n');
        }
    });

    // 1. Sync Full Chat History (Messages)
    sock.ev.on('messaging-history.set', ({ chats, messages, contacts }) => {
        console.log(`📥 Received ${messages.length} historical messages from WhatsApp!`);
        baileysEmitter.emit('sync-history', { messages });
    });

    // 2. Sync Real Groups
    sock.ev.on('groups.upsert', (groups) => {
        console.log(`👥 Received ${groups.length} groups from WhatsApp!`);
        baileysEmitter.emit('sync-groups', groups);
    });

    // 3. Sync Real Call Logs
    sock.ev.on('call', (calls) => {
        console.log(`📞 Received real WhatsApp call logs!`);
        baileysEmitter.emit('sync-calls', calls);
    });

    // 4. Listen for Anti-Delete (Message Revokes)
    sock.ev.on('messages.update', (updates) => {
        for (let update of updates) {
            if (update.update.message === null) {
                // This means the message was deleted!
                baileysEmitter.emit('msg-revoked', update.key);
            }
        }
    });
    // Listen for real WhatsApp contacts
    sock.ev.on('contacts.upsert', (contacts) => {
        console.log(`📇 Received ${contacts.length} contacts from WhatsApp!`);
        baileysEmitter.emit('contacts.upsert', contacts);
    });

    sock.ev.on('contacts.update', (updates) => {
        baileysEmitter.emit('contacts.update', updates);
    });
    // Listen for Real WhatsApp Statuses
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (msg.key.remoteJid === 'status@broadcast' && !msg.key.fromMe) {
            console.log('📸 Received Real WhatsApp Status from:', msg.pushName || msg.key.participant);
            baileysEmitter.emit('waStatus', msg);
        }
    });
    sock.ev.on('creds.update', saveCreds);
}
async function reactToStatus(statusKey, emoji) {
    if (!sock || !isReady) return { ok: false, error: 'WhatsApp not connected' };
    try {
        // The JID for all status updates is always 'status@broadcast'
        await sock.sendMessage('status@broadcast', {
            react: {
                text: emoji,
                key: statusKey
            }
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function sendWhatsAppMessage(phone, text) {
    if (!sock || !isReady) return { ok: false, error: 'WhatsApp not connected' };
    try {
        const cleaned = String(phone).replace(/\D/g, '');
        const jid = cleaned + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function isWhatsAppReady() { return isReady; }

connectToWhatsApp();

module.exports = { sendWhatsAppMessage, reactToStatus, isWhatsAppReady, baileysEmitter };