const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const { exec } = require('child_process');
const fs = require('fs');

async function runQrService() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', '', '']
  });

  sock.ev.on('creds.update', saveCreds);

  let firstOpen = false;
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      const qrPath = 'C:\\Users\\Dell\\Desktop\\SCAN_ME.png';
      // Générer une image QR parfaite, haute résolution et nette
      await QRCode.toFile(qrPath, qr, {
        width: 500,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
      console.log('NEW_QR_IMAGE_READY');

      // Ouvrir l'image immédiatement sur l'écran
      if (!firstOpen) {
        firstOpen = true;
        exec('mspaint.exe "C:\\Users\\Dell\\Desktop\\SCAN_ME.png"');
      }
    }

    if (connection === 'open') {
      console.log('WHATSAPP_CONNECTED_SUCCESSFULLY!');
      fs.writeFileSync('C:\\Users\\Dell\\Desktop\\WHATSAPP_CONNECTED.txt', 'SUCCESS');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        runQrService();
      }
    }
  });
}

runQrService();
