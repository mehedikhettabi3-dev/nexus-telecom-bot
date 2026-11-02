const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function pairAndStay() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  let requested = false;
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr && !requested) {
      requested = true;
      try {
        const code = await sock.requestPairingCode('212699469649');
        console.log('\n========================================');
        console.log('🔥 NEW PAIRING CODE:', code);
        console.log('========================================\n');
      } catch (e) {
        console.error('Error pairing:', e.message);
      }
    }

    if (connection === 'open') {
      console.log('🎉 SUCCESS! WHATSAPP CONNECTED 100%!');
      process.exit(0);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        pairAndStay();
      }
    }
  });
}

pairAndStay();
