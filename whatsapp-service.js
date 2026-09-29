const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

let sock = null;
let isReady = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
        // No printQRInTerminal — we handle it manually below
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

    sock.ev.on('creds.update', saveCreds);
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

module.exports = { sendWhatsAppMessage, isWhatsAppReady };