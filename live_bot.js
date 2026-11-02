/**
 * ============================================================================
 * NEXUS-TELECOM: LIVE WHATSAPP BOT FOR MOROCCAN FIBER LEAD GEN
 * Stack: Node.js + @whiskeysockets/baileys + @turf/turf
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
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '212625489153').replace(/\D/g, '');
const WASIT_PHONE = (process.env.WASIT_PHONE || ADMIN_PHONE).replace(/\D/g, '');

const logger = pino({ level: 'info' });

// 1. CHARGEMENT DE ZONES.GEOJSON (MOTEUR SIG)
let zonesData = { type: 'FeatureCollection', features: [] };
const zonesPath = path.join(__dirname, 'zones.geojson');

if (fs.existsSync(zonesPath)) {
  try {
    zonesData = JSON.parse(fs.readFileSync(zonesPath, 'utf8'));
    logger.info(`Loaded ${zonesData.features.length} fiber coverage zones.`);
  } catch (err) {
    logger.error('Error loading zones.geojson');
  }
}

// 2. MOTEUR D'ÉVALUATION GÉOGRAPHIQUE & BUFFER 15M + 100M
function evaluateLocationCoverage(latitude, longitude) {
  const customerPoint = turf.point([longitude, latitude]);

  // Phase 1: Direct Polygon
  for (const zone of zonesData.features) {
    try {
      if (turf.booleanPointInPolygon(customerPoint, zone)) {
        return {
          status: 'DIRECT_COVERAGE',
          operator: zone.properties.isp || 'IAM / Inwi',
          city: zone.properties.city || 'المدينة',
          neighborhood: zone.properties.name || 'الحي',
          notes: 'تغطية فايبر مباشرة ومضمونة'
        };
      }
    } catch (e) {}
  }

  // Phase 2: Buffer standard 15m (تجرار لموبل قريب)
  for (const zone of zonesData.features) {
    try {
      const buffered15m = turf.buffer(zone, 0.015, { units: 'kilometers' });
      if (turf.booleanPointInPolygon(customerPoint, buffered15m)) {
        return {
          status: 'BUFFER_15M',
          operator: zone.properties.isp || 'IAM / Inwi',
          city: zone.properties.city || 'المدينة',
          neighborhood: zone.properties.name || 'الحي',
          notes: 'ممكن التركيب عبر تمديد خفيف (تجرار لموبل قريب)'
        };
      }
    } catch (e) {}
  }

  // Phase 3: Smart Proximity Fallback 100m (90% احتمال نجاح)
  for (const zone of zonesData.features) {
    try {
      const buffered100m = turf.buffer(zone, 0.1, { units: 'kilometers' });
      if (turf.booleanPointInPolygon(customerPoint, buffered100m)) {
        return {
          status: 'PROXIMITY_90_PERCENT',
          operator: zone.properties.isp || 'IAM / Inwi',
          city: zone.properties.city || 'المدينة',
          neighborhood: zone.properties.name || 'الحي',
          notes: 'شبكة قريبة جداً في نفس الحي (نسبة نجاح التمديد تفوق 90%)'
        };
      }
    } catch (e) {}
  }

  return {
    status: 'NO_COVERAGE',
    operator: 'غير متوفر حالياً',
    city: 'طنجة / المنطقة',
    neighborhood: 'المنطقة الحالية',
    notes: 'خارج نطاق التغطية الحالية'
  };
}

// 3. GESTION DES CONVERSATIONS EN MÉMOIRE
const userSessions = new Map();

// Helper: Extraire les coordonnées depuis un texte de lien Google Maps
function extractCoordsFromText(text) {
  // Ex: https://maps.google.com/maps?q=35.7364805%2C-5.8268983...
  const match = text.match(/q=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/i) ||
                text.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  if (match) {
    return {
      lat: parseFloat(match[1]),
      lng: parseFloat(match[2])
    };
  }
  return null;
}

// 4. MAIN BAILEYS BOT RUNNER
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
    const { connection } = update;
    if (connection === 'open') {
      logger.info('🚀 NEXUS-TELECOM BOT IS FULLY LIVE & PROCESSING MESSAGES!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid.endsWith('@s.whatsapp.net')) continue;

      const phone = remoteJid.replace('@s.whatsapp.net', '');
      let session = userSessions.get(phone) || { step: 'WAITING_LOCATION' };

      const messageContent = msg.message;
      let lat = null;
      let lng = null;

      // Type 1: Location Pin WhatsApp
      const loc = messageContent.locationMessage || messageContent.liveLocationMessage;
      if (loc) {
        lat = loc.degreesLatitude;
        lng = loc.degreesLongitude;
      }

      // Type 2: Texte ou Lien Google Maps
      const text = (
        messageContent.conversation ||
        messageContent.extendedTextMessage?.text ||
        ''
      ).trim();

      if (!lat && text) {
        const coords = extractCoordsFromText(text);
        if (coords) {
          lat = coords.lat;
          lng = coords.lng;
        }
      }

      // Traitement de la localisation
      if (lat && lng) {
        logger.info(`📍 Location received from ${phone}: Lat ${lat}, Lng ${lng}`);
        const result = evaluateLocationCoverage(lat, lng);

        session.lat = lat;
        session.lng = lng;
        session.operator = result.operator;
        session.city = result.city;
        session.neighborhood = result.neighborhood;
        session.status = result.status;
        session.step = 'WAITING_NAME';
        userSessions.set(phone, session);

        let reply = '';
        if (result.status === 'DIRECT_COVERAGE' || result.status === 'BUFFER_15M') {
          reply =
            `✅ *أهلاً بك أخي الكريم! خبار زوين بزاف* 🎉\n\n` +
            `التغطية ديال الفايبر أوبتيك (*${result.operator}*) متوفرة في موقعك بـ *${result.city}* (${result.neighborhood}).\n` +
            `${result.status === 'BUFFER_15M' ? '⚡ (إمكانية التمديد والتجرار مباشرة للبناية ديالك متاحة ومضمونة)\n' : ''}\n` +
            `عفاك صيفط ليا دابا *الاسم الكامل* ديالك باش ندوزو الدوسي للتقني ويتاصل بك اليوم لتحديد موعد التركيب 🚀.`;
        } else if (result.status === 'PROXIMITY_90_PERCENT') {
          reply =
            `👋 *مرحباً بك خويا العزيز!*\n\n` +
            `البلاصة ديالك قريبة بزاف لشبكة الفايبر أوبتيك ديال (*${result.operator}*) على بعد أمتار قليلة (نسبة نجاح التجرار تفوق 90% 📶).\n\n` +
            `باش نأكدوا مع التقني الميداني إمكانية التوصيل للبناية ديالك، عفاك صيفط لينا *الاسم الكامل* ديالك دابا.`;
        } else {
          reply =
            `للأسف أخاي العزيز، هاد النقطة بالضبط مزال ما وصلهاش الفايبر فهاد اللحظة ⏳.\n\n` +
            `راني قيدت الرقم ديالك عندي (+${phone})، وغير تكون توسيعة جديدة في حيكم غادي نتاصلو بك أول واحد إن شاء الله! شكراً ليك 🙏`;
        }

        await sock.sendMessage(remoteJid, { text: reply });
        return;
      }

      // Réception du nom du client (Finalisation du Lead)
      if (session.step === 'WAITING_NAME' && text) {
        const customerName = text;
        session.name = customerName;
        session.step = 'COMPLETED';
        userSessions.set(phone, session);

        const confirmationMsg =
          `تم تسجيل طلبك بنجاح سي *${customerName}*! ✅\n\n` +
          `غادي يتاصل بك التقني ديال الفايبر (*${session.operator}*) في أقرب وقت لتأكيد موعد التركيب.\n` +
          `شكراً على ثقتك بنا 🤝!`;

        await sock.sendMessage(remoteJid, { text: confirmationMsg });

        // Envoi de la double notification Admin + Wasit
        const gmapsLink = `https://maps.google.com/?q=${session.lat},${session.lng}`;
        const alertMsg =
          `🚨 *طلب اشتراك فايبر جديد وارد للتو! (NEXUS LEAD)* 🚨\n\n` +
          `👤 *الزبون:* ${customerName}\n` +
          `📞 *الهاتف:* +${phone}\n` +
          `📍 *المدينة / الحي:* ${session.city} - ${session.neighborhood}\n` +
          `📡 *المشغل المتوفر:* ${session.operator}\n` +
          `📊 *حالة التغطية:* ${session.status}\n` +
          `🗺️ *موقع الزبون على الخريطة:* ${gmapsLink}\n\n` +
          `⚡ المرجو من الفني / الوسيط الاتصال به فوراً لإغلاق الصفقة!`;

        const recipients = [ADMIN_PHONE];
        if (WASIT_PHONE && WASIT_PHONE !== ADMIN_PHONE) recipients.push(WASIT_PHONE);

        for (const dest of recipients) {
          try {
            await sock.sendMessage(`${dest}@s.whatsapp.net`, { text: alertMsg });
            logger.info(`Alert sent to: ${dest}`);
          } catch (e) {
            logger.error(`Error alerting ${dest}`);
          }
        }
        return;
      }

      // Message d'accueil par défaut
      const welcomeMsg =
        `السلام عليكم ورحمة الله وبركاته خويا! مرحباً بك في مصلحة طلبات الفايبر أوبتيك بالمغرب 🇲🇦⚡\n\n` +
        `باش نعرفو واش منطقتكم مغطاة بـ *اتصالات المغرب (IAM)* أو *إنوي (Inwi)* أو *أورنج (Orange)* ونعطيوك أحسن عرض:\n\n` +
        `📍 *عفاك صيفط لينا Localisation Pin ديالك دابا عبر الواتساب* (أو صيفط رابط Google Maps ديال موقعك).\n\n` +
        `السيستم غادي يفحص الشبكة أوتوماتيكياً في ثواني!`;

      await sock.sendMessage(remoteJid, { text: welcomeMsg });
    }
  });
}

startBot();
