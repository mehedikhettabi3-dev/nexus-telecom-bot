/**
 * ============================================================================
 * NEXUS-TELECOM BOT v4.0 — PRODUCTION ENGINE
 * Fixes:
 *  1. Admin recognition — no alerts sent to admin for his own messages
 *  2. Client notification to admin with client phone number
 *  3. Group messages fully blocked
 *  4. Name validation — rejects links/phone numbers/long texts
 *  5. WiFi drop recovery — waits for internet before reconnecting (no spam)
 *  6. Spatial BBox index for fast GIS (2,448 zones, <100ms response)
 *  7. Natural 5-second typing delay for customers
 * ============================================================================
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const turf = require('@turf/turf');
const dns = require('dns');
const net = require('net');
const { EventEmitter } = require('events');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '212625489153').replace(/\D/g, '');
const WASIT_PHONE = (process.env.WASIT_PHONE || '212699469649').replace(/\D/g, '');
const BOT_PHONE   = (process.env.BOT_PHONE   || '212699469649').replace(/\D/g, '');

// All admin/operator numbers that the bot knows — will not treat them as clients
const KNOWN_ADMINS = new Set([ADMIN_PHONE, WASIT_PHONE, BOT_PHONE]);

const logger = pino({ level: 'info' });
const botSentIds = new Set();
let reconnectDelay = 3000;

// ============================================================================
// 1. LOAD 2,448 REAL ZONES + SPATIAL BOUNDING-BOX INDEX
// ============================================================================
let spatialIndex = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'zones.geojson'), 'utf8');
  const zonesData = JSON.parse(raw);
  spatialIndex = zonesData.features
    .filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    .map(f => {
      try { return { bbox: turf.bbox(f), feature: f }; }
      catch (_) { return null; }
    })
    .filter(Boolean);
  logger.info(`✅ Loaded ${zonesData.features.length} zones. Index: ${spatialIndex.length} entries.`);
} catch (e) {
  logger.error('❌ Failed to load zones.geojson: ' + e.message);
}

// ============================================================================
// 2. GIS ENGINE — BBox pre-filter + accurate nearest-point distance
// ============================================================================
const BBOX_PAD = 1500 / 111320; // 1.5km in degrees

function evaluateRealCoverage(lat, lng) {
  const pt = turf.point([lng, lat]);
  const candidates = spatialIndex.filter(({ bbox }) =>
    lng >= bbox[0] - BBOX_PAD && lng <= bbox[2] + BBOX_PAD &&
    lat >= bbox[1] - BBOX_PAD && lat <= bbox[3] + BBOX_PAD
  );
  logger.info(`🔍 [GIS] ${candidates.length} candidates for (${lat.toFixed(4)}, ${lng.toFixed(4)})`);

  let nearestZone = null;
  let minDist = 9999999;

  for (const { feature: f } of candidates) {
    try {
      if (turf.booleanPointInPolygon(pt, f)) {
        return { status: 'DIRECT', zoneName: f.properties.name || 'المنطقة', operator: op(f), distanceMeters: 0 };
      }
    } catch (_) {}
    try {
      let d;
      if (f.geometry.type === 'MultiPolygon') {
        d = Math.min(...f.geometry.coordinates.map(coords => {
          const np = turf.nearestPointOnLine(turf.polygonToLine(turf.polygon(coords)), pt);
          return turf.distance(pt, np, { units: 'meters' });
        }));
      } else {
        const np = turf.nearestPointOnLine(turf.polygonToLine(f), pt);
        d = turf.distance(pt, np, { units: 'meters' });
      }
      if (d < minDist) { minDist = d; nearestZone = f; }
    } catch (_) {
      try {
        const d = turf.distance(pt, turf.centroid(f), { units: 'meters' });
        if (d < minDist) { minDist = d; nearestZone = f; }
      } catch (_) {}
    }
  }

  const name = nearestZone?.properties?.name || 'المنطقة';
  const d = Math.round(minDist);
  const operator = nearestZone ? op(nearestZone) : 'IAM / Inwi';

  if (d <= 50)  return { status: 'BUFFER_15M',   zoneName: name, operator, distanceMeters: d };
  if (d <= 300) return { status: 'PROXIMITY_90',  zoneName: name, operator, distanceMeters: d };
  if (d <= 700) return { status: 'PROXIMITY_FAR', zoneName: name, operator, distanceMeters: d };
  return { status: 'NO_COVERAGE', zoneName: name, operator: 'غير متوفر', distanceMeters: d };
}

function op(f) {
  const fill = (f.properties?.fill || '').toLowerCase();
  const name = (f.properties?.name || '').toLowerCase();
  if (fill === '#00aaff' || name.includes('inwi')) return 'Inwi';
  if (name.includes('iam') || name.includes('itissalat')) return 'اتصالات المغرب (IAM)';
  return 'IAM / Inwi';
}

// ============================================================================
// 3. COORD EXTRACTOR
// ============================================================================
function extractCoords(msg) {
  const loc = msg.locationMessage || msg.liveLocationMessage;
  if (loc?.degreesLatitude) return { lat: loc.degreesLatitude, lng: loc.degreesLongitude };
  const text = (msg.conversation || msg.extendedTextMessage?.text || '').trim();
  const m1 = text.match(/[?&]q=(-?\d+\.?\d*)(?:%2C|,)(-?\d+\.?\d*)/i);
  if (m1) return { lat: +m1[1], lng: +m1[2] };
  const m2 = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (m2) return { lat: +m2[1], lng: +m2[2] };
  const m3 = text.match(/(-?\d{1,3}\.\d{4,})\s*[,،]\s*(-?\d{1,3}\.\d{4,})/);
  if (m3) return { lat: +m3[1], lng: +m3[2] };
  return null;
}

// ============================================================================
// 4. SESSIONS
// ============================================================================
const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { step: 'IDLE', lastActivity: Date.now() });
  return sessions.get(phone);
}

// ============================================================================
// 5. SEND HELPERS
// ============================================================================
async function sendWithDelay(sock, jid, text) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, 4500));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  return sent;
}

async function sendNow(sock, jid, text) {
  const sent = await sock.sendMessage(jid, { text });
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  return sent;
}

// ============================================================================
// 6. ADMIN ALERTS — with client phone number
// ============================================================================
async function alertAdmins(sock, clientPhone, event, extra = '') {
  const msg =
    `🔔 *إشعار NEXUS-TELECOM* 🔔\n\n` +
    `📞 *رقم الزبون:* +${clientPhone}\n` +
    `📋 *الحدث:* ${event}` +
    (extra ? `\n${extra}` : '');
  for (const r of [...new Set([ADMIN_PHONE, WASIT_PHONE])]) {
    try { await sendNow(sock, `${r}@s.whatsapp.net`, msg); }
    catch (_) {}
  }
}

async function sendLeadAlert(sock, clientPhone, name, result, lat, lng) {
  const link = `https://maps.google.com/?q=${lat},${lng}`;
  const msg =
    `🚨 *NEXUS LEAD — طلب فايبر مؤهل جديد* 🚨\n\n` +
    `👤 *الزبون:* ${name}\n` +
    `📞 *الهاتف:* +${clientPhone}\n` +
    `📍 *أقرب كابلاج:* ${result.zoneName}\n` +
    `📏 *المسافة:* ${result.distanceMeters}م\n` +
    `📡 *المشغل:* ${result.operator}\n` +
    `📊 *التغطية:* ${result.status}\n` +
    `🗺️ *الموقع:* ${link}\n\n` +
    `⚡ تواصل مع الزبون فوراً لإغلاق الصفقة!`;
  for (const r of [...new Set([ADMIN_PHONE, WASIT_PHONE])]) {
    try {
      await sendNow(sock, `${r}@s.whatsapp.net`, msg);
      logger.info(`📨 Lead alert sent to ${r}`);
    } catch (e) { logger.warn(`Alert failed for ${r}: ${e.message}`); }
  }
}

// ============================================================================
// 7. NAME VALIDATOR
// ============================================================================
function isValidName(t) {
  if (!t || t.length < 2 || t.length > 40) return false;
  if (/https?:\/\/|www\.|📍|\+212|\+2[0-9]{11}|\d{8,}|📞/.test(t)) return false;
  // Reject if it contains too many newlines (job listings, etc.)
  if ((t.match(/\n/g) || []).length > 2) return false;
  return true;
}

// ============================================================================
// 8. MESSAGE HANDLER
// ============================================================================
async function handleMessage(sock, msg) {
  if (!msg.message) return;
  if (botSentIds.has(msg.key?.id)) return;

  const jid = msg.key?.remoteJid;
  if (!jid) return;
  // Block groups and broadcast
  if (jid.includes('@g.us') || jid === 'status@broadcast') return;
  // Block fromMe
  if (msg.key.fromMe) return;

  const phone = jid.replace(/@.*$/, '');
  const isAdmin = KNOWN_ADMINS.has(phone);

  const coords = extractCoords(msg.message);
  const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

  logger.info(`📥 [${phone}${isAdmin ? ' ADMIN' : ''}] text="${rawText.slice(0, 30)}" coords=${!!coords}`);

  // ── ADMIN sends a message → just acknowledge, don't treat as client
  if (isAdmin) {
    logger.info(`👑 Admin message received from ${phone} — no auto-reply.`);
    return;
  }

  // ── CLIENT message — notify admin with phone number immediately
  const session = getSession(phone);
  const isNewClient = session.step === 'IDLE';
  session.lastActivity = Date.now();

  // Send quick notification to admin on first contact
  if (isNewClient) {
    await alertAdmins(sock, phone, 'زبون جديد بدأ محادثة مع البوت 💬');
  }

  // — 1. LOCATION
  if (coords) {
    const result = evaluateRealCoverage(coords.lat, coords.lng);
    Object.assign(session, { lat: coords.lat, lng: coords.lng, result, step: 'WAITING_NAME' });

    let reply;
    if (result.status === 'DIRECT') {
      reply = `🎉 *خبار زوين بزاف أخي!*\n\nالفايبر أوبتيك (*${result.operator}*) متوفر مباشرة في بقعتك (*${result.zoneName}*) ✅\n\nصيفط لينا *الاسم الكامل* ديالك باش نسجلو الطلب ويتاصل بك التقني اليوم 🚀`;
    } else if (['BUFFER_15M', 'PROXIMITY_90'].includes(result.status)) {
      reply = `👋 *أهلاً بك خويا!*\n\nموقعك قريب من شبكة الفايبر (*${result.operator}*) — أقرب كابل في *${result.zoneName}* على بعد ${result.distanceMeters}م ⚡\n\nإمكانية التوصيل 90% 📶\n\nصيفط لينا *الاسم الكامل* ديالك باش يخرج التقني يفحص ويتاصل بك!`;
    } else if (result.status === 'PROXIMITY_FAR') {
      reply = `🙏 *السلام عليكم أخاي!*\n\nموقعك على بعد *${result.distanceMeters}م* من أقرب كابلاج (*${result.zoneName}*).\n\nالتغطية غير مؤكدة، خاصنا فني ميداني.\n\nصيفط لينا *الاسم الكامل* ديالك باش نقيدوك ونرسل فني! 📋`;
    } else {
      session.step = 'IDLE';
      reply = `للأسف أخاي، موقعك بعيد على شبكة الفايبر الحالية (${result.distanceMeters}م) ⏳\n\nقيدت رقمك (+${phone}) وغادي نعلموك أول ما يصل الكابلاج لحيكم إن شاء الله 🙏`;
    }
    await sendWithDelay(sock, jid, reply);
    return;
  }

  // — 2. NAME (after location)
  if (session.step === 'WAITING_NAME') {
    if (!isValidName(rawText)) {
      await sendWithDelay(sock, jid, `عفاك أخي صيفط لينا *الاسم الكامل* ديالك فقط (مثلاً: محمد أمين) 🙏`);
      return;
    }
    session.name = rawText;
    session.step = 'COMPLETED';
    await sendWithDelay(sock, jid,
      `✅ تم تسجيل طلبك بنجاح سي *${rawText}*!\n\nسيتاصل بك التقني ديال *${session.result.operator}* في أقرب وقت لتحديد موعد التركيب المجاني 🚀\n\nشكراً على ثقتك! 🤝`
    );
    await sendLeadAlert(sock, phone, rawText, session.result, session.lat, session.lng);
    logger.info(`✅ LEAD: ${rawText} | +${phone} | ${session.result.status} | ${session.result.zoneName}`);
    return;
  }

  // — 3. DEFAULT WELCOME
  session.step = 'WAITING_LOCATION';
  await sendWithDelay(sock, jid,
    `السلام عليكم ورحمة الله! مرحباً بك في خدمة *الفايبر أوبتيك بالمغرب* 🇲🇦⚡\n\nنغطي شبكات *IAM* و*Inwi* — 2,448 منطقة على الخريطة الحقيقية.\n\n📍 *صيفط لينا Localisation Pin ديالك* من واتساب أو رابط Google Maps وغادي نعطيوك نتيجة التغطية في ثواني!`
  );
}

// ============================================================================
// 9. INTERNET CHECK — works with WiFi, mobile hotspot, ethernet, any connection
// ============================================================================
let internetWasDown = false;

function checkInternet() {
  return new Promise((resolve) => {
    // Try TCP connect to Google DNS — works regardless of which network interface
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(53, '8.8.8.8');
  });
}

async function waitForInternet(timeout = 600000) { // wait up to 10 min
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeout) {
    const online = await checkInternet();
    if (online) {
      if (internetWasDown) {
        logger.info('✅ Internet RESTORED — reconnecting to WhatsApp...');
        internetWasDown = false;
      }
      return true;
    }
    attempt++;
    internetWasDown = true;
    // Log every 5 attempts to avoid spam
    if (attempt % 5 === 1) logger.info(`⏳ [${attempt}] No internet yet (WiFi/hotspot off?) — waiting...`);
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// ============================================================================
// 10. MAIN BOT — Smart reconnect with WiFi-aware backoff
// ============================================================================
async function startBot() {
  logger.info('🚀 Nexus-Telecom Bot v4.0 starting...');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', '', ''],
    connectTimeoutMs: 20000,
    keepAliveIntervalMs: 15000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      reconnectDelay = 3000; // reset delay on success
      logger.info('🎉 NEXUS-TELECOM BOT IS LIVE AND CONNECTED 24/7! 🚀');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      logger.warn(`⚠️ Disconnected [${code}]`);

      if (code === DisconnectReason.loggedOut) {
        logger.error('🔴 Logged out! Delete auth_info_baileys/ and re-scan QR.');
        process.exit(1);
      }

      // ANY disconnect — check internet first before reconnecting
      // This covers: WiFi off (408/503), PC sleep, router restart, etc.
      internetWasDown = true;
      logger.info('📡 Connection lost. Waiting for internet before reconnecting...');
      const online = await waitForInternet(300000); // wait up to 5 min
      if (online) {
        reconnectDelay = 3000; // reset delay — internet is back
      } else {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      }

      logger.info(`🔁 Reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
      setTimeout(startBot, reconnectDelay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try { await handleMessage(sock, msg); }
      catch (e) { logger.error(`Handler error: ${e.message}`); }
    }
  });
}

process.on('uncaughtException', (e) => {
  logger.error('Uncaught: ' + e.message);
  setTimeout(startBot, 5000);
});

startBot();
