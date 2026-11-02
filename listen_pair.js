const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

async function main() {
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

  let done = false;
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && !done) {
      done = true;
      try {
        const code = await sock.requestPairingCode('212699469649');
        console.log('PAIR_CODE_OUTPUT:' + code);
        fs.writeFileSync('C:\\Users\\Dell\\Desktop\\CODE.txt', code);
      } catch (err) {
        console.error('PAIR_ERR:', err.message);
      }
    }

    if (connection === 'open') {
      console.log('CONNECTION_OPEN_SUCCESS');
      fs.writeFileSync('C:\\Users\\Dell\\Desktop\\STATUS.txt', 'CONNECTED');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        main();
      }
    }
  });
}

main();
