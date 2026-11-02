const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function getCode() {
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

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection } = update;
    if (qr) {
      try {
        const code = await sock.requestPairingCode('212699469649');
        console.log('FINAL_CODE:', code);
        process.exit(0);
      } catch (e) {
        console.error('ERROR_PAIRING:', e.message);
        process.exit(1);
      }
    }
  });
}

getCode();
