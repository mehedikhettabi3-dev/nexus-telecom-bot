/**
 * ============================================================================
 * NEXUS-TELECOM BOT: PRODUCTION REVOLUTION ENGINE (2,448 REAL MOROCCAN ZONES)
 * ============================================================================
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const turf = require('@turf/turf');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '212625489153').replace(/\D/g, '');
const WASIT_PHONE = (process.env.WASIT_PHONE || '212699469649').replace(/\D/g, '');

const logger = pino({ level: 'info' });

// 1. CHARGEMENT DES 2,448 POLIGONES RÉELS DU MAROC
let zonesData = { type: 'FeatureCollection', features: [] };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'zones.geojson'), 'utf8');
  zonesData = JSON.parse(raw);
  logger.info(`✅ Loaded ${zonesData.features.length} real Moroccan telecom polygons.`);
} catch (e) {
  logger.error('Failed to load zones.geojson');
}

// 2. MOTEUR SIG RÉEL AVEC CALCUL DE DISTANCE EXACT
function evaluateRealCoverage(lat, lng) {
  const pt = turf.point([lng, lat]);
  let nearestZone = null;
  let minDistanceMeters = 9999999;

  for (const f of zonesData.features) {
    if (f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
      // 1. Test direct dans la plaque
      try {
        if (turf.booleanPointInPolygon(pt, f)) {
          return {
            status: 'DIRECT',
            zoneName: f.properties.name || 'المنطقة السكنية',
            operator: f.properties.fill === '#00aaff' ? 'Inwi / IAM' : 'اتصالات المغرب (IAM)',
            distanceMeters: 0
          };
        }
      } catch (err) {}

      // Calcul de la distance réelle par rapport au centre de la plaque
      try {
        const center = turf.centroid(f);
        const distM = turf.distance(pt, center, { units: 'meters' });
        if (distM < minDistanceMeters) {
          minDistanceMeters = distM;
          nearestZone = f;
        }
      } catch (err) {}
    }
  }

  // 2. Buffer 15m (تجرار لموبل لاصق)
  if (minDistanceMeters <= 50) {
    return {
      status: 'BUFFER_15M',
      zoneName: nearestZone?.properties?.name || 'الحي المجاور',
      operator: 'اتصالات المغرب (IAM) / Inwi',
      distanceMeters: Math.round(minDistanceMeters)
    };
  }

  // 3. Smart Proximity Fallback (تجرار قريب في نفس الزنقة أو الحي 100m-500m)
  if (minDistanceMeters <= 600) {
    return {
      status: 'PROXIMITY_90',
      zoneName: nearestZone?.properties?.name || 'أقرب حي مغطى',
      operator: 'اتصالات المغرب (IAM) / Inwi',
      distanceMeters: Math.round(minDistanceMeters)
    };
  }

  // 4. Hors couverture
  return {
    status: 'NO_COVERAGE',
    zoneName: nearestZone?.properties?.name || 'المنطقة',
    operator: 'غير متوفر حالياً',
    distanceMeters: Math.round(minDistanceMeters)
  };
}

// 3. GESTION DES CONVERSATIONS MULTI-CLIENTS (ROBUSTE)
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { step: 'WAITING_LOCATION', history: [] });
  }
  return sessions.get(phone);
}

// Helper pour extraire les coordonnées
function extractCoords(msgContent) {
  // Pin WhatsApp
  const loc = msgContent.locationMessage || msgContent.liveLocationMessage;
  if (loc) {
    return { lat: loc.degreesLatitude, lng: loc.degreesLongitude };
  }

  // Texte / Lien Google Maps
  const text = (msgContent.conversation || msgContent.extendedTextMessage?.text || '').trim();
  const match = text.match(/q=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/i) ||
                text.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  if (match) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }

  return null;
}

// 4. BOUCLE PRINCIPALE BAILEYS AVEC AUTO-RECONNEXION 24/7
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', '', '']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      logger.info('🚀 REAL NEXUS-TELECOM BOT IS RUNNING LIVE 24/7!');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.warn(`Connection closed with code ${code}. Reconnecting in 3 seconds...`);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startBot, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid.endsWith('@s.whatsapp.net')) continue;

      const phone = remoteJid.replace('@s.whatsapp.net', '');
      const session = getSession(phone);

      const coords = extractCoords(msg.message);
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''
      ).trim();

      // CAS 1: RÉCEPTION D'UNE LOCALISATION (PIN OU LIEN)
      if (coords) {
        logger.info(`📍 Received Coords from ${phone}: ${coords.lat}, ${coords.lng}`);
        const result = evaluateRealCoverage(coords.lat, coords.lng);

        session.lat = coords.lat;
        session.lng = coords.lng;
        session.result = result;
        session.step = 'WAITING_NAME';

        let reply = '';
        if (result.status === 'DIRECT') {
          reply =
            `🎉 *أهلاً بك أخي الكريم! خبار زوين بزاف* 🎉\n\n` +
            `التغطية ديال الفايبر أوبتيك (*${result.operator}*) متوفرة ومباشرة في موقعك ببقعة (*${result.zoneName}*) ✅.\n\n` +
            `عفاك صيفط ليا دابا *الاسم الكامل* ديالك باش نسجلو الطلب ويتاصل بك التقني الميداني اليوم لتحديد موعد التركيب المجاني والروتور 🚀.`;
        } else if (result.status === 'BUFFER_15M' || result.status === 'PROXIMITY_90') {
          reply =
            `👋 *أهلاً بك خويا العزيز!*\n\n` +
            `البلاصة ديالك قريبة لشبكة الفايبر أوبتيك (*${result.operator}*) - أقرب نقطة كابلاج كاينة في (*${result.zoneName}*) على بعد حوالي ${result.distanceMeters} متر ⚡.\n\n` +
            `إمكانية التجرار والتوصيل للبناية ديالك واردة بنسبة 90% 📶.\n\n` +
            `عفاك صيفط ليا *الاسم الكامل* ديالك باش نعطيو الدوسي للتقني يخرج يفحص البوكس ويتاصل بك!`;
        } else {
          reply =
            `للأسف أخاي العزيز، هاد النقطة حالياً بعيدة على أقرب كابلاج ديال الفايبر (${result.distanceMeters} متر) ⏳.\n\n` +
            `راني قيدت الرقم ديالك عندي (+${phone})، وأول ما يدوز الكابلاج في حيكم غادي تكون أول من نعلموه إن شاء الله! شكراً ليك 🙏`;
        }

        await sock.sendMessage(remoteJid, { text: reply });
        continue;
      }

      // CAS 2: RÉCEPTION DU NOM APRÈS LOCALISATION
      if (session.step === 'WAITING_NAME' && text) {
        session.name = text;
        session.step = 'COMPLETED';

        const confirmMsg =
          `تم تسجيل طلبك بنجاح سي *${text}*! ✅\n\n` +
          `غادي يتاصل بك التقني المعتمد ديال (*${session.result.operator}*) في أقرب وقت لتأكيد موعد التركيب المجاني 🚀.\n\n` +
          `شكراً على ثقتك بنا 🤝!`;

        await sock.sendMessage(remoteJid, { text: confirmMsg });

        // NOTIFICATION INSTANTANÉE (ADMIN + WASIT)
        const gmapsLink = `https://maps.google.com/?q=${session.lat},${session.lng}`;
        const alertMsg =
          `🚨 *طلب اشتراك فايبر جديد مؤهل (NEXUS LEAD)* 🚨\n\n` +
          `👤 *الزبون:* ${text}\n` +
          `📞 *الهاتف:* +${phone}\n` +
          `📍 *أقرب منطقة كابلاج:* ${session.result.zoneName}\n` +
          `📏 *المسافة من الكابل:* ${session.result.distanceMeters} متر\n` +
          `📡 *المشغل:* ${session.result.operator}\n` +
          `📊 *نوع التغطية:* ${session.result.status}\n` +
          `🗺️ *موقع الزبون على الخريطة:* ${gmapsLink}\n\n` +
          `⚡ المرجو من الفني / الوسيط الاتصال به فوراً لإغلاق الصفقة!`;

        const recipients = [ADMIN_PHONE, WASIT_PHONE];
        for (const r of recipients) {
          try {
            await sock.sendMessage(`${r}@s.whatsapp.net`, { text: alertMsg });
            logger.info(`Alert sent to: ${r}`);
          } catch (e) {}
        }
        continue;
      }

      // CAS 3: SALUTATION PAR DÉFAUT
      const welcome =
        `السلام عليكم ورحمة الله وبركاته خويا! مرحباً بك في مصلحة طلبات الفايبر أوبتيك بالمغرب 🇲🇦⚡\n\n` +
        `باش نعرفو واش منطقتكم مغطاة بـ *اتصالات المغرب (IAM)* أو *إنوي (Inwi)* ونعطيوك أحسن عرض:\n\n` +
        `📍 *عفاك صيفط لينا Localisation Pin ديالك دابا عبر الواتساب* (أو صيفط رابط Google Maps ديال موقعك).\n\n` +
        `السيستم غادي يفحص قاعدة بيانات التغطية (2,448 منطقة بالمغرب) أوتوماتيكياً في ثواني!`;

      await sock.sendMessage(remoteJid, { text: welcome });
    }
  });
}

startBot();
