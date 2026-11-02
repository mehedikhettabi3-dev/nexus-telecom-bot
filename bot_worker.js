const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const turf = require('@turf/turf');
const fs = require('fs');
const pino = require('pino');

let zones = { type: 'FeatureCollection', features: [] };
try {
  zones = JSON.parse(fs.readFileSync('zones.geojson', 'utf8'));
} catch (e) {}

function evaluateCoverage(lat, lng) {
  const pt = turf.point([lng, lat]);
  for (const z of zones.features) {
    if (turf.booleanPointInPolygon(pt, z)) return { status: 'DIRECT', isp: z.properties.isp, city: z.properties.city };
    const b15 = turf.buffer(z, 0.015, { units: 'kilometers' });
    if (turf.booleanPointInPolygon(pt, b15)) return { status: 'BUFFER_15M', isp: z.properties.isp, city: z.properties.city };
    const b100 = turf.buffer(z, 0.1, { units: 'kilometers' });
    if (turf.booleanPointInPolygon(pt, b100)) return { status: 'PROXIMITY_90', isp: z.properties.isp, city: z.properties.city };
  }
  return { status: 'PROXIMITY_90', isp: 'IAM / Inwi', city: 'طنجة' };
}

const sessions = new Map();

async function start() {
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

  sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') {
      console.log('✅ BOT DAEMON LISTENING FOR INCOMING MESSAGES 24/7');
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(start, 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
      const phone = remoteJid.replace('@s.whatsapp.net', '');
      const sess = sessions.get(phone) || { step: 'WAITING_LOC' };

      const m = msg.message;
      let lat = null, lng = null;

      const loc = m.locationMessage || m.liveLocationMessage;
      if (loc) { lat = loc.degreesLatitude; lng = loc.degreesLongitude; }

      const text = (m.conversation || m.extendedTextMessage?.text || '').trim();
      console.log('INCOMING TEXT:', text);

      if (!lat && text) {
        const match = text.match(/q=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/i) || text.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
        if (match) { lat = parseFloat(match[1]); lng = parseFloat(match[2]); }
      }

      if (lat && lng) {
        console.log('EVALUATING COORDS:', lat, lng);
        const res = evaluateCoverage(lat, lng);
        sess.lat = lat; sess.lng = lng; sess.isp = res.isp; sess.city = res.city; sess.step = 'WAITING_NAME';
        sessions.set(phone, sess);

        const rep = '✅ *أهلاً بك أخي الكريم! خبار زوين بزاف* 🎉\n\n' +
          'التغطية ديال الفايبر أوبتيك (*' + res.isp + '*) متوفرة ومؤهلة في منطقتكم بـ *' + res.city + '*.\n\n' +
          'عفاك صيفط ليا دابا *الاسم الكامل* ديالك باش نسجلو الطلب ويتاصل بك التقني الميداني اليوم لتحديد موعد التركيب المجاني 🚀.';
        await sock.sendMessage(remoteJid, { text: rep });
        continue;
      }

      if (sess.step === 'WAITING_NAME' && text) {
        sess.name = text; sess.step = 'COMPLETED';
        sessions.set(phone, sess);

        await sock.sendMessage(remoteJid, {
          text: 'تم تسجيل طلبك بنجاح سي *' + text + '*! ✅\n\nغادي يتاصل بك التقني ديال الفايبر (*' + sess.isp + '*) في أقرب وقت لتأكيد موعد التركيب.\nشكراً على ثقتك بنا 🤝!'
        });

        const alert = '🚨 *طلب اشتراك فايبر جديد وارد للتو! (NEXUS LEAD)* 🚨\n\n' +
          '👤 *الزبون:* ' + text + '\n' +
          '📞 *الهاتف:* +' + phone + '\n' +
          '📍 *المدينة:* ' + sess.city + '\n' +
          '📡 *المشغل:* ' + sess.isp + '\n' +
          '🗺️ *الموقع:* https://maps.google.com/?q=' + sess.lat + ',' + sess.lng + '\n\n' +
          '⚡ المرجو من الفني / الوسيط الاتصال به فوراً!';

        await sock.sendMessage('212625489153@s.whatsapp.net', { text: alert });
        await sock.sendMessage('212699469649@s.whatsapp.net', { text: alert });
        continue;
      }

      const welcome = 'السلام عليكم ورحمة الله وبركاته خويا! مرحباً بك في مصلحة طلبات الفايبر أوبتيك بالمغرب 🇲🇦⚡\n\n' +
        '📍 *عفاك صيفط لينا Localisation Pin ديالك دابا عبر الواتساب* (أو رابط Google Maps) باش نفحصو التغطية في ثواني!';
      await sock.sendMessage(remoteJid, { text: welcome });
    }
  });
}
start();
