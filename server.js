'use strict';
/* ==========================================================================
   WESAM TECH - سيرفر الهوتسبت (النسخة النهائية)
   --------------------------------------------------------------------------
   شو بيعمل هاد الملف؟
   1) بيتحقق من رسالة الدفع (Jawwal Pay) وبيبيع بطاقة من المخزون.
   2) بيدير المخزون (إضافة بطاقات / عرضها) من صفحة /admin ومن بوت تيليجرام.
   3) بوت تيليجرام بأزرار: عرض البطاقات، حالة الراوتر، إضافة بطاقات، المبيعات...
   4) إشعارات: بيعة جديدة، مخزون قليل، أول تسجيل دخول للبطاقة، قرب انتهاء البطاقة،
      انقطاع الراوتر، تغيّر الـ IP العام.
   5) الراوتر بيبعت إشارات للسيرفر (سكربتات بمجلد router/).

   ملاحظة: بدون أي مكتبات خارجية (Node 18 أو أحدث). كل الأسرار بمتغيرات Render
   (Environment) وليس هون بالملف.
   ========================================================================== */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ==========================================================================
   1) الإعدادات - كلها بتنقرأ من Render > Environment
   ========================================================================== */
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';                 // باسورد صفحة /admin (إجباري)
const SELLER_LAST9 = (process.env.SELLER_NUMBER || '0599747574').replace(/\D/g, '').slice(-9); // رقمك
const REQUIRE_RECEIPT = process.env.REQUIRE_RECEIPT === 'true'; // true = لازم إشعار استلام من جوالك
const INCOMING_SECRET = process.env.INCOMING_SECRET || '';     // سر تطبيق SMS Forwarder (إشعار الاستلام)
const RECEIPT_MAX_AGE_MIN = Number(process.env.RECEIPT_MAX_AGE_MIN || 30);
const HASH_TTL_SEC = 60 * 60 * 24 * 30;                        // رسالة الدفع المستخدمة ما بتنقبل 30 يوم

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';         // توكن بوت تيليجرام
const OWNERS = String(process.env.TELEGRAM_CHAT_ID || '')      // رقمك (ممكن أكتر من رقم بفاصلة)
  .split(',').map(s => s.trim()).filter(Boolean);
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const TG_SECRET = crypto.createHash('sha256').update(TG_TOKEN || 'x').digest('hex').slice(0, 32); // سر الـ webhook
const LOW_STOCK = Number(process.env.LOW_STOCK || 3);          // نبّهني لما يضل هالعدد أو أقل بالباقة
const WARN_MIN = Number(process.env.WARN_MIN || 10);           // نبّهني قبل انتهاء البطاقة بـ X دقيقة

const ROUTER_SECRET = process.env.ROUTER_SECRET || '';         // سر سكربتات الراوتر
const OFFLINE_MIN = Number(process.env.OFFLINE_MIN || 3);      // الراوتر "منقطع" إذا ما بعت إشارة X دقيقة
const TZ_NAME = process.env.TZ_NAME || 'Asia/Hebron';          // توقيت فلسطين
const TICK_MS = Number(process.env.TICK_MS || 30000);          // كل قديش نفحص (للانتهاء/الانقطاع)
const TEST_FORCE_MINUTES = Number(process.env.TEST_FORCE_MINUTES || 0); // للتجربة فقط، اتركه فاضي

/* --------------------------------------------------------------------------
   الباقات: id = اسم داخلي ثابت (لا تغيّره بعد ما تبدأ البيع)
            name = الاسم اللي بيشوفه الزبون
            price = السعر بالشيكل (الزبون لازم يحوّل نفس المبلغ بالضبط)
            minutes = مدة البطاقة بالدقائق من أول تسجيل دخول (null = دائمة / بدون تنبيه انتهاء)
   لإضافة باقة: أضف سطر جديد. أمثلة جاهزة مكتوبة بالأسفل (شيل // لتفعيلها)
   -------------------------------------------------------------------------- */
const PLANS = [
  { id: 'd1',  name: '24 ساعة', price: 1,  minutes: 24 * 60 },
  { id: 'd3',  name: '3 أيام',  price: 3,  minutes: 3 * 24 * 60 },
  { id: 'd7',  name: 'أسبوع',   price: 7,  minutes: 7 * 24 * 60 },
  { id: 'd10', name: '10 أيام', price: 10, minutes: 10 * 24 * 60 },
  { id: 'd30', name: 'شهري',    price: 30, minutes: 30 * 24 * 60 }
  // { id: 'm3',   name: '3 شهور', price: 80,  minutes: 90 * 24 * 60 },
  // { id: 'life', name: 'دائمة',  price: 300, minutes: null }
];

/* ==========================================================================
   2) التخزين
   - Upstash Redis (دائم) إذا المتغيران موجودين. وإلا ملف data.json (مؤقت، بينمسح على Render).
   - الواجهة (الدوال) نفسها بالاثنين، فباقي الكود ما بيهتم أي واحد مستخدم.
   ========================================================================== */
class FileStore {
  constructor(file) {
    this.f = file;
    this.db = { stock: {}, hashes: {}, sales: [], receipts: {}, h: {} };
    try { Object.assign(this.db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
  }
  _save() {
    try { fs.writeFileSync(this.f + '.tmp', JSON.stringify(this.db)); fs.renameSync(this.f + '.tmp', this.f); }
    catch (e) { console.error('save error', e.message); }
  }
  /* المخزون: قائمة بطاقات لكل باقة */
  async count(p) { return (this.db.stock[p] || []).length; }
  async list(p) { return (this.db.stock[p] || []).slice(); }
  async push(p, arr) { (this.db.stock[p] = this.db.stock[p] || []).push(...arr); this._save(); }
  async pop(p) { const a = this.db.stock[p] || []; const v = a.shift(); this._save(); return v || null; }
  /* منع تكرار رسالة الدفع */
  async claimHash(h, ttl) {
    const now = Date.now(), e = this.db.hashes[h];
    if (e && e > now) return false;
    this.db.hashes[h] = now + ttl * 1000; this._save(); return true;
  }
  async releaseHash(h) { delete this.db.hashes[h]; this._save(); }
  /* سجل المبيعات */
  async addSale(s) { this.db.sales.unshift(s); if (this.db.sales.length > 1000) this.db.sales.length = 1000; this._save(); }
  async sales(n) { return this.db.sales.slice(0, n); }
  /* إشعارات الاستلام القادمة من جوالك */
  async addReceipt(k, o) { (this.db.receipts[k] = this.db.receipts[k] || []).push(o); this._save(); }
  async popReceipt(k, maxAgeMs) {
    const a = this.db.receipts[k] || [];
    while (a.length) { const r = a.shift(); if (Date.now() - r.t <= maxAgeMs) { this._save(); return r; } }
    this._save(); return null;
  }
  /* جداول (Hash): meta = معلومات كل بطاقة، acts = تفعيلات البطاقات */
  async hGet(n, k) { return (this.db.h[n] || {})[k] || null; }
  async hSet(n, k, v) { (this.db.h[n] = this.db.h[n] || {})[k] = v; this._save(); }
  async hSetMany(n, obj) { const h = (this.db.h[n] = this.db.h[n] || {}); Object.assign(h, obj); this._save(); }
  async hSetNX(n, k, v) { const h = (this.db.h[n] = this.db.h[n] || {}); if (k in h) return false; h[k] = v; this._save(); return true; }
  async hAll(n) { return Object.assign({}, this.db.h[n] || {}); }
}

class RedisStore {
  constructor(url, token) { this.url = url; this.token = token; }
  async cmd(args) {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  async count(p) { return Number(await this.cmd(['LLEN', 'stock:' + p])) || 0; }
  async list(p) { return (await this.cmd(['LRANGE', 'stock:' + p, 0, -1])) || []; }
  async push(p, arr) { if (arr.length) await this.cmd(['RPUSH', 'stock:' + p, ...arr]); }
  async pop(p) { return (await this.cmd(['LPOP', 'stock:' + p])) || null; }   // LPOP ذرّي: مستحيل بطاقة تنباع مرتين
  async claimHash(h, ttl) { return (await this.cmd(['SET', 'hash:' + h, '1', 'NX', 'EX', ttl])) === 'OK'; }
  async releaseHash(h) { await this.cmd(['DEL', 'hash:' + h]); }
  async addSale(s) { await this.cmd(['LPUSH', 'sales', JSON.stringify(s)]); await this.cmd(['LTRIM', 'sales', 0, 999]); }
  async sales(n) { return ((await this.cmd(['LRANGE', 'sales', 0, n - 1])) || []).map(x => JSON.parse(x)); }
  async addReceipt(k, o) { await this.cmd(['RPUSH', 'rcpt:' + k, JSON.stringify(o)]); await this.cmd(['EXPIRE', 'rcpt:' + k, 86400]); }
  async popReceipt(k, maxAgeMs) {
    for (let i = 0; i < 30; i++) {
      const v = await this.cmd(['LPOP', 'rcpt:' + k]);
      if (!v) return null;
      const r = JSON.parse(v);
      if (Date.now() - r.t <= maxAgeMs) return r;
    }
    return null;
  }
  async hGet(n, k) { return (await this.cmd(['HGET', n, k])) || null; }
  async hSet(n, k, v) { await this.cmd(['HSET', n, k, v]); }
  async hSetMany(n, obj) { const a = []; for (const k in obj) a.push(k, obj[k]); if (a.length) await this.cmd(['HSET', n, ...a]); }
  async hSetNX(n, k, v) { return (await this.cmd(['HSETNX', n, k, v])) === 1; }
  async hAll(n) {
    const r = (await this.cmd(['HGETALL', n])) || [];
    if (!Array.isArray(r)) return r;
    const o = {}; for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1]; return o;
  }
}

const store = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new RedisStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : new FileStore(path.join(__dirname, 'data.json'));
console.log('Storage:', store instanceof RedisStore ? 'Upstash Redis (دائم)' : 'File (مؤقت!)');

/* ==========================================================================
   3) أدوات عامة (وقت، نصوص، حماية)
   ========================================================================== */
/* تاريخ + ساعة بتوقيت فلسطين، مثال: 22/11/2026, 14:30:05 */
function fmtDT(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_NAME, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(ms));
}
/* مدة بالعربي، مثال: 2 يوم و 3 ساعة و 10 دقيقة */
function fmtDur(ms) {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60, p = [];
  if (d) p.push(d + ' يوم'); if (h) p.push(h + ' ساعة'); if (mm || !p.length) p.push(mm + ' دقيقة');
  return p.join(' و ');
}
/* تهريب HTML (لأن رسائل تيليجرام بصيغة HTML والزبون ممكن يكتب أي شي) */
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* مقارنة آمنة للأسرار (ضد هجمات التوقيت) */
function eq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function isAdmin(req) { return !!ADMIN_KEY && eq(req.headers['x-admin-key'] || '', ADMIN_KEY); }
function isRouter(req, b) { return !!ROUTER_SECRET && eq(req.headers['x-secret'] || b.secret || '', ROUTER_SECRET); }

/* حد المحاولات لكل IP */
const ipHits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  const a = (ipHits.get(ip) || []).filter(t => now - t < windowMs);
  a.push(now); ipHits.set(ip, a);
  return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of ipHits) if (!v.some(t => now - t < 3600000)) ipHits.delete(k); }, 600000).unref();

/* ==========================================================================
   4) تحليل رسالة جوال باي
   الصيغة المطلوبة: تم تحويل ILS 6.00 الى 00970599747574 رصيدك الحالي ILS 94.00
   ========================================================================== */
function normalize(s) {
  return String(s || '')
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660))   // أرقام عربية -> إنجليزية
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x6F0))
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')           // رموز اتجاه مخفية
    .replace(/\u066b/g, '.').replace(/\u066c/g, ',')
    .replace(/\s+/g, ' ').trim();
}
const SMS_RE = /تم\s*تحويل\s*ILS\s*([\d,]+(?:\.\d+)?)\s*(?:الى|إلى|الي)\s*\+?(\d{9,15})\s*رصيدك\s*الحالي\s*ILS\s*([\d,]+(?:\.\d+)?)/i;
function num(x) { return parseFloat(String(x).replace(/,/g, '')); }
function parseSms(raw) {
  const s = normalize(raw);
  if (!s) return { ok: false, error: 'الصق رسالة الدفع كاملة' };
  if (s.length > 300) return { ok: false, error: 'الرسالة طويلة، الصق رسالة التحويل فقط' };
  const m = s.match(SMS_RE);
  if (!m) return { ok: false, error: 'صيغة الرسالة غير صحيحة. لازم تكون رسالة جوال باي الأصلية: «تم تحويل ILS ... الى ... رصيدك الحالي ILS ...»' };
  const amount = num(m[1]), balance = num(m[3]);
  if (!isFinite(amount) || !isFinite(balance) || amount <= 0 || balance < 0) return { ok: false, error: 'أرقام الرسالة غير صالحة' };
  return { ok: true, amount, to: m[2].slice(-9), balance };
}

/* ==========================================================================
   5) إدارة البطاقات
   ========================================================================== */
/* قراءة نص البطاقات. كل سطر = بطاقة.
   الأشكال المقبولة:  user pass   |   user,pass   |   user:pass   |   user (يوزر = باسورد)
   - أي حروف وأرقام ورموز وأي طول (لحد 64 حرف).
   - اليوزر لحد أول فاصل (مسافة , ; : |)، وكل الباقي باسورد (فالباسورد ممكن يحتوي رموز). */
function parseCards(text) {
  const cards = [], bad = [], seen = new Set();
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim(); if (!t) return;
    const m = t.match(/^(\S+?)(?:[\s,;:|]+(.+))?$/);
    if (!m) { bad.push(t); return; }
    const u = m[1], p = (m[2] || u).trim();
    if (u.length > 64 || p.length > 64) { bad.push(t); return; }
    if (seen.has(u)) return;
    seen.add(u); cards.push({ u, p });
  });
  return { cards, bad };
}

/* كل اليوزرات المعروفة (بالمخزون + انباعت + مضافة سابقاً) لمنع التكرار */
async function knownUsers() {
  const set = new Set(Object.keys(await store.hAll('meta')));
  for (const pl of PLANS) (await store.list(pl.id)).forEach(x => { try { set.add(JSON.parse(x).u); } catch (e) {} });
  (await store.sales(1000)).forEach(s => set.add(s.user));
  return set;
}

/* إضافة بطاقات لباقة (بتستخدم من /admin ومن تيليجرام) */
async function addCards(planId, text) {
  const { cards, bad } = parseCards(text);
  const known = await knownUsers();
  const fresh = [], dup = [];
  for (const c of cards) { if (known.has(c.u)) dup.push(c.u); else { known.add(c.u); fresh.push(c); } }
  await store.push(planId, fresh.map(c => JSON.stringify(c)));
  const meta = {}; fresh.forEach(c => { meta[c.u] = JSON.stringify({ plan: planId, pass: c.p }); });
  await store.hSetMany('meta', meta);               // نربط كل يوزر بباقته (لنعرف مدته عند التفعيل)
  return { added: fresh.length, dup: dup.length, bad: bad.length, stock: await store.count(planId) };
}

/* دوّر على بطاقة بالـ meta (طلب واحد) + هل لسا بمخزون باقتها (ما انباعت)؟ */
async function lookupCard(user) {
  const m = await store.hGet('meta', user);
  if (!m) return null;
  try {
    const o = JSON.parse(m);
    const inStock = (await store.list(o.plan)).some(x => { try { return JSON.parse(x).u === user; } catch (e) { return false; } });
    return { plan: o.plan, pass: o.pass, inStock };
  } catch (e) { return null; }
}

/* عند تشغيل السيرفر: نكمّل meta لأي بطاقة قديمة (بالمخزون أو بالمبيعات) ما إلها سجل */
async function migrateMeta() {
  const meta = await store.hAll('meta'), add = {};
  for (const pl of PLANS) for (const x of await store.list(pl.id)) {
    try { const c = JSON.parse(x); if (!meta[c.u]) add[c.u] = JSON.stringify({ plan: pl.id, pass: c.p }); } catch (e) {}
  }
  for (const s of await store.sales(1000)) {
    if (meta[s.user] || add[s.user]) continue;
    const pl = PLANS.find(p => p.name === s.plan);
    if (pl) add[s.user] = JSON.stringify({ plan: pl.id, pass: s.pass || '' });
  }
  await store.hSetMany('meta', add);
}

/* ==========================================================================
   6) تيليجرام: إرسال + أزرار + أوامر
   ========================================================================== */
async function tg(method, params) {
  if (!TG_TOKEN) return null;
  try {
    const r = await fetch(TG_API + '/bot' + TG_TOKEN + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
    });
    return await r.json();
  } catch (e) { console.error('tg', method, e.message); return null; }
}
/* تقسيم الرسائل الطويلة (حد تيليجرام 4096 حرف) */
function chunks(text, max) {
  const out = []; let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur); return out;
}
/* إرسال رسالة لشخص (الأزرار بتنحط على آخر جزء) */
async function say(chat, text, markup) {
  const parts = chunks(text, 3800);
  for (let i = 0; i < parts.length; i++) {
    await tg('sendMessage', {
      chat_id: chat, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: i === parts.length - 1 ? markup : undefined
    });
  }
}
/* إشعار لكل أصحاب البوت (إنت) */
async function notify(text, markup) { for (const o of OWNERS) await say(o, text, markup); }

/* الأزرار */
const BTN_MENU = { text: '🏠 القائمة', callback_data: 'menu' };
const KB_MAIN = { inline_keyboard: [
  [{ text: '📦 البطاقات المتاحة', callback_data: 'cards' }],
  [{ text: '📡 حالة الراوتر', callback_data: 'status' }, { text: '🟢 البطاقات المفعّلة', callback_data: 'active' }],
  [{ text: '➕ إضافة بطاقات', callback_data: 'add' }, { text: '📊 آخر المبيعات', callback_data: 'sales' }]
] };
/* أزرار الباقات: prefix = c: (عرض) أو a: (إضافة) */
function kbPlans(prefix, withAll) {
  const rows = []; let row = [];
  PLANS.forEach(p => { row.push({ text: p.name, callback_data: prefix + p.id }); if (row.length === 2) { rows.push(row); row = []; } });
  if (row.length) rows.push(row);
  if (withAll) rows.push([{ text: '📋 كل الأقسام', callback_data: prefix + 'all' }]);
  rows.push([BTN_MENU]);
  return { inline_keyboard: rows };
}

/* نص ملخص المخزون */
async function stockText() {
  const lines = [];
  for (const pl of PLANS) {
    const n = await store.count(pl.id);
    lines.push((n === 0 ? '🚨' : n <= LOW_STOCK ? '⚠️' : '📦') + ' ' + esc(pl.name) + ': <b>' + n + '</b>');
  }
  return lines.join('\n');
}
async function showMenu(chat) {
  await say(chat, '🏠 <b>WESAM TECH - القائمة الرئيسية</b>\n\n' + await stockText(), KB_MAIN);
}

/* عرض البطاقات المتاحة مع الباسوردات */
async function showCards(chat, planId) {
  const list = planId === 'all' ? PLANS : PLANS.filter(p => p.id === planId);
  for (let i = 0; i < list.length; i++) {
    const pl = list[i];
    const cards = (await store.list(pl.id)).map(x => JSON.parse(x));
    let t = '📦 <b>' + esc(pl.name) + '</b> (' + pl.price + ' شيكل) — <b>' + cards.length + '</b> بطاقة\n';
    t += cards.length ? cards.map(c => '<code>' + esc(c.u) + (c.p !== c.u ? '  ' + esc(c.p) : '') + '</code>').join('\n') : '(فاضي)';
    const last = i === list.length - 1;
    const kb = last ? { inline_keyboard: [
      planId !== 'all' ? [{ text: '➕ إضافة لهذه الباقة', callback_data: 'a:' + pl.id }] : [], [BTN_MENU]
    ].filter(r => r.length) } : undefined;
    await say(chat, t, kb);
  }
}

/* حالة الراوتر (بتتحدث من إشارات سكربت الراوتر) */
/* router = إشارات جهاز المراقبة (صفحة /monitor) أو سكربت الراوتر - هاي اللي بتحدد متصل/منقطع
   portal = آخر مرة زبون فتح صفحة الدخول (بنعرف منها IP العام وعنوان الهوتسبت) */
const router = { t: 0, ip: '', hsIp: '', wanIp: '', uptime: 0, clients: '', offlineNotified: false, portal: { t: 0, ip: '', host: '' } };
function statusText() {
  const now = Date.now(), L = ['📡 <b>حالة الراوتر</b>', ''];
  const hs = router.hsIp || router.portal.host;
  if (router.t) {
    const online = now - router.t <= OFFLINE_MIN * 60000;
    L.push(online ? '🟢 <b>متصل بالإنترنت</b>' : '🔴 <b>غير متصل</b> (آخر إشارة قبل ' + fmtDur(now - router.t) + ')');
    L.push('🌍 IP العام: <code>' + esc(router.ip || router.portal.ip || '-') + '</code>');
    if (router.wanIp) L.push('🔌 IP الـ WAN على الراوتر: <code>' + esc(router.wanIp) + '</code>');
    if (router.clients !== '') L.push('👥 الأجهزة بالهوتسبت (تقريبي): ' + esc(router.clients));
    if (router.uptime) L.push('⏱ الراوتر شغال منذ: ' + fmtDur(router.uptime * 1000));
    L.push('🕐 آخر إشارة: ' + fmtDT(router.t));
  } else {
    L.push('⚪ حالة الاتصال غير متاحة: ما في جهاز مراقبة شغّال', '(افتح صفحة /monitor على جهاز متصل بالهوتسبت)');
    if (router.portal.ip) L.push('🌍 آخر IP عام شفته من زبون: <code>' + esc(router.portal.ip) + '</code>');
  }
  L.push('📶 عنوان الهوتسبت: <code>' + esc(hs || '-') + '</code>');
  if (router.portal.t) L.push('👥 آخر زبون فتح صفحة الدخول: ' + fmtDT(router.portal.t));
  L.push('', '🗓 الآن: <b>' + fmtDT(now) + '</b>');
  return L.join('\n');
}

/* حالة تيليجرام "بانتظار بطاقات": بعد ضغط زر إضافة بنستنى رسالتك فيها البطاقات */
const pending = new Map();

async function onCallback(chat, data) {
  if (data === 'menu') { pending.delete(chat); return showMenu(chat); }
  if (data === 'cards') return say(chat, '📦 اختر القسم:', kbPlans('c:', true));
  if (data.startsWith('c:')) return showCards(chat, data.slice(2));
  if (data === 'status') return say(chat, statusText(), { inline_keyboard: [[{ text: '🔄 تحديث', callback_data: 'status' }, BTN_MENU]] });
  if (data === 'active') {
    const now = Date.now();
    const list = Object.values(acts).filter(r => !r.exp || r.exp > now).sort((a, b) => (a.exp || 9e15) - (b.exp || 9e15)).slice(0, 40);
    const t = list.length ? list.map(r => '👤 <code>' + esc(r.user) + '</code> — ' + esc(r.planName) + ' — ' + (r.exp ? 'باقي ' + fmtDur(r.exp - now) : 'دائمة')).join('\n') : 'ما في بطاقات مفعّلة حالياً';
    return say(chat, '🟢 <b>البطاقات المفعّلة</b> (' + list.length + ')\n\n' + t, { inline_keyboard: [[BTN_MENU]] });
  }
  if (data === 'sales') {
    const s = await store.sales(10);
    const t = s.length ? s.map(x => '🕐 ' + fmtDT(x.t) + '\n📦 ' + esc(x.plan) + ' | <code>' + esc(x.user) + '</code> <code>' + esc(x.pass || '') + '</code>').join('\n\n') : 'ما في مبيعات بعد';
    return say(chat, '📊 <b>آخر المبيعات</b>\n\n' + t, { inline_keyboard: [[BTN_MENU]] });
  }
  if (data === 'add') return say(chat, '➕ لأي باقة بدك تضيف بطاقات؟', kbPlans('a:', false));
  if (data.startsWith('a:')) {
    const pl = PLANS.find(p => p.id === data.slice(2)); if (!pl) return;
    pending.set(chat, pl.id);
    return say(chat, '➕ إضافة بطاقات لباقة <b>' + esc(pl.name) + '</b>\n\nأرسل البطاقات بالرسالة الجاية، <b>كل بطاقة بسطر</b>:\n<code>user1 pass1\nuser2 pass2\nabc123 xyz789</code>\n(بطاقة بكود واحد؟ اكتبه لحاله)\nأي حروف وأرقام وأي طول (حتى 64).',
      { inline_keyboard: [[{ text: '❌ إلغاء', callback_data: 'menu' }]] });
  }
}

async function onText(chat, text) {
  if (text.startsWith('/')) { pending.delete(chat); return showMenu(chat); }
  const planId = pending.get(chat);
  if (!planId) return showMenu(chat);
  const pl = PLANS.find(p => p.id === planId);
  const r = await addCards(planId, text);
  pending.delete(chat);
  await say(chat, '✅ تمت إضافة <b>' + r.added + '</b> بطاقة لباقة ' + esc(pl.name) +
    (r.dup ? '\n⚠️ تجاهلت ' + r.dup + ' مكررة (موجودة أو انباعت سابقاً)' : '') +
    (r.bad ? '\n⚠️ تجاهلت ' + r.bad + ' سطر غير صالح' : '') +
    '\n📦 المخزون الآن: <b>' + r.stock + '</b>',
    { inline_keyboard: [[{ text: '➕ إضافة أخرى', callback_data: 'a:' + planId }], [BTN_MENU]] });
}

/* استقبال تحديثات تيليجرام (من الـ webhook) - بس أنت مسموح */
async function onTelegram(u) {
  const cb = u.callback_query, msg = u.message;
  const chat = cb ? cb.message && cb.message.chat.id : msg && msg.chat.id;
  const from = cb ? cb.from.id : msg && msg.from && msg.from.id;
  if (!chat) return;
  if (!OWNERS.includes(String(from))) { if (msg) await say(chat, '⛔ غير مصرّح لك'); return; }
  if (cb) { await tg('answerCallbackQuery', { callback_query_id: cb.id }); return onCallback(chat, cb.data || ''); }
  if (msg && msg.text) return onText(chat, msg.text.trim());
}

/* تسجيل الـ webhook تلقائياً عند تشغيل السيرفر */
async function setupTelegram() {
  if (!TG_TOKEN) { console.log('Telegram: غير مفعّل (ما في TELEGRAM_BOT_TOKEN)'); return; }
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) { console.log('Telegram: ما لقيت رابط السيرفر (PUBLIC_URL)، الأزرار ما رح تشتغل لكن الإشعارات شغالة'); return; }
  const r = await tg('setWebhook', { url: base.replace(/\/$/, '') + '/tg', secret_token: TG_SECRET, allowed_updates: ['message', 'callback_query'] });
  console.log('Telegram webhook:', r && r.ok ? 'OK' : JSON.stringify(r));
  await tg('setMyCommands', { commands: [{ command: 'menu', description: 'القائمة الرئيسية' }] });
}

/* ==========================================================================
   7) التفعيلات (أول تسجيل دخول) + تنبيهات الانتهاء + مراقبة الراوتر
   ========================================================================== */
let acts = {};            // كل البطاقات اللي تفعّلت (بالذاكرة + محفوظة بالتخزين)
const startedAt = Date.now();
async function loadActs() {
  const all = await store.hAll('acts'); acts = {};
  for (const k in all) { try { acts[k] = JSON.parse(all[k]); } catch (e) {} }
}

/* تخمين نوع الجهاز من User-Agent (للإشعار فقط) */
function devName(ua) {
  ua = String(ua || '');
  if (/iPhone/i.test(ua)) return 'iPhone'; if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android'; if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac'; if (/Linux/i.test(ua)) return 'Linux';
  return '';
}

/* بتنادى لما يوزر يسجّل دخول (من صفحة الدخول أو من سكربت الراوتر) إنو يوزر سجّل دخول. بتتصرف فقط أول مرة لكل يوزر */
async function onLogin(user, mac, cip, device) {
  if (!user) return false;
  const info = await lookupCard(user);
  const plan = info && PLANS.find(p => p.id === info.plan);
  const t = Date.now();
  const minutes = TEST_FORCE_MINUTES || (plan && plan.minutes) || 0;
  const rec = { user, plan: plan ? plan.id : null, planName: plan ? plan.name : 'غير معروفة', t,
                exp: minutes ? t + minutes * 60000 : null, mac: mac || '', ip: cip || '', warned: false, done: false };
  if (!(await store.hSetNX('acts', user, JSON.stringify(rec)))) return false;   // مو أول مرة -> تجاهل
  acts[user] = rec;
  notify('🟢 <b>تم تفعيل بطاقة (أول تسجيل دخول)</b>\n━━━━━━━━━━\n' +
    '👤 اليوزر: <code>' + esc(user) + '</code>\n' +
    (info && info.pass ? '🔑 الباسورد: <code>' + esc(info.pass) + '</code>\n' : '') +
    '📦 الباقة: ' + esc(rec.planName) + '\n' +
    '🕐 وقت التفعيل: ' + fmtDT(t) + '\n' +
    (rec.exp ? '⏳ تنتهي: ' + fmtDT(rec.exp) + ' (بعد ' + fmtDur(rec.exp - t) + ')\n' : '♾ بدون تاريخ انتهاء\n') +
    (mac ? '📱 MAC: <code>' + esc(mac) + '</code>\n' : '') +
    (cip ? '🌐 IP الجهاز: <code>' + esc(cip) + '</code>\n' : '') +
    (device ? '📱 الجهاز: ' + esc(device) + '\n' : '') +
    (info && info.inStock ? '\n🚨 <b>تنبيه:</b> هذه البطاقة ما انباعت عبر السيرفر (لسا بالمخزون)! ممكن حدا خمّنها.' : ''));
  return true;
}

/* فحص دوري: قرب انتهاء البطاقات + انتهاؤها + انقطاع الراوتر */
async function tick() {
  const now = Date.now();
  for (const rec of Object.values(acts)) {
    if (!rec.exp || rec.done) continue;
    const left = rec.exp - now; let changed = false;
    if (left > 0 && left <= WARN_MIN * 60000 && !rec.warned) {
      rec.warned = true; changed = true;
      notify('⏳ <b>بطاقة بدها تخلص</b>\n👤 <code>' + esc(rec.user) + '</code> — ' + esc(rec.planName) +
        '\nباقي: <b>' + fmtDur(left) + '</b>\nتنتهي: ' + fmtDT(rec.exp));
    }
    if (left <= 0) {
      rec.done = true; rec.warned = true; changed = true;
      if (-left < 6 * 3600000) notify('⌛ <b>انتهت بطاقة</b>\n👤 <code>' + esc(rec.user) + '</code> — ' + esc(rec.planName) + '\nانتهت: ' + fmtDT(rec.exp));
    }
    if (changed) { try { await store.hSet('acts', rec.user, JSON.stringify(rec)); } catch (e) { console.error(e.message); } }
  }
  if (router.t && !router.offlineNotified && now - router.t > OFFLINE_MIN * 60000 && now - startedAt > OFFLINE_MIN * 60000) {
    router.offlineNotified = true;
    notify('🔴 <b>الراوتر انقطع!</b>\nآخر إشارة: ' + fmtDT(router.t) + '\nآخر IP عام: <code>' + esc(router.ip) + '</code>');
  }
}

/* ==========================================================================
   8) HTTP: أدوات
   ========================================================================== */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 50000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
/* بيقبل JSON أو form-encoded (لأن سكربتات الراوتر و SMS Forwarder بيبعتوا أشكال مختلفة) */
async function bodyObj(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw); } catch (e) {}
  const o = {}; new URLSearchParams(raw).forEach((v, k) => { o[k] = v; }); return o;
}

/* ==========================================================================
   9) المسارات (API)
   ========================================================================== */
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  /* CORS: يسمح لصفحة الدخول (على الراوتر) تتصل بالسيرفر */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* فحص الصحة (UptimeRobot بيعمل ping عليه) */
  if (p === '/' || p === '/health') return send(res, 200, { ok: true, service: 'wesam-tech-hotspot' });

  /* --- الباقات + هل في بطاقات متاحة (بتستخدمها صفحة الدخول) --- */
  if (p === '/api/plans' && req.method === 'GET') {
    const plans = [];
    for (const pl of PLANS) plans.push({ id: pl.id, name: pl.name, price: pl.price, available: (await store.count(pl.id)) > 0 });
    return send(res, 200, { ok: true, seller: '0' + SELLER_LAST9, plans });
  }

  /* --- شراء بطاقة --- */
  if (p === '/api/buy' && req.method === 'POST') {
    /* ملاحظة: كل زبائن الهوتسبت بيظهروا للسيرفر بنفس الـ IP (IP الراوتر)، فالحد لازم يكون واسع */
    if (limited(ip, 40, 10 * 60 * 1000)) return send(res, 429, { ok: false, error: 'محاولات كتيرة، جرّب بعد شوي' });
    const b = await bodyObj(req);
    const plan = PLANS.find(x => x.id === b.planId);
    if (!plan) return send(res, 400, { ok: false, error: 'باقة غير صحيحة' });

    /* (أ) فحص الرسالة: الصيغة + المبلغ + رقمك */
    const sms = parseSms(b.message);
    if (!sms.ok) return send(res, 400, { ok: false, error: sms.error });
    if (Math.abs(sms.amount - plan.price) > 0.001)
      return send(res, 400, { ok: false, error: 'المبلغ بالرسالة (' + sms.amount.toFixed(2) + ' ILS) لا يطابق سعر الباقة (' + plan.price.toFixed(2) + ' ILS)' });
    if (sms.to !== SELLER_LAST9)
      return send(res, 400, { ok: false, error: 'الرسالة محوّلة لرقم غير رقم البائع' });
    if ((await store.count(plan.id)) === 0)
      return send(res, 409, { ok: false, error: 'نفدت بطاقات هذه الباقة حالياً، تواصل مع وسام' });

    /* (ب) منع تكرار نفس الرسالة */
    const hash = crypto.createHash('sha256').update(sms.amount.toFixed(2) + '|' + sms.to + '|' + sms.balance.toFixed(2)).digest('hex');
    if (!(await store.claimHash(hash, HASH_TTL_SEC))) {
      notify('⚠️ <b>محاولة شراء برسالة مكررة</b>\n📦 ' + esc(plan.name) + '\n🌐 ' + esc(ip) + '\n<code>' + esc(normalize(b.message).slice(0, 200)) + '</code>');
      return send(res, 409, { ok: false, error: 'هذه الرسالة مستخدمة من قبل' });
    }

    /* (ج) تأكيد الاستلام من جوالك (إذا مفعّل REQUIRE_RECEIPT) */
    let receipt = null;
    if (REQUIRE_RECEIPT) {
      receipt = await store.popReceipt(sms.amount.toFixed(2), RECEIPT_MAX_AGE_MIN * 60000);
      if (!receipt) {
        await store.releaseHash(hash);
        notify('⏳ <b>زبون دفع بس ما وصل إشعار استلام</b>\n📦 ' + esc(plan.name) + ' (' + plan.price + ' شيكل)\n🌐 ' + esc(ip) + '\n<code>' + esc(normalize(b.message).slice(0, 200)) + '</code>\nإذا الدفعة وصلتك فعلاً، أعطه بطاقة يدوي.');
        return send(res, 402, { ok: false, error: 'لم يصلنا تأكيد استلام الدفعة بعد. انتظر دقيقة وحاول مرة ثانية' });
      }
    }

    /* (د) سحب البطاقة من المخزون (السحب بيحذفها فوراً = ما بتنباع لحدا ثاني) */
    const raw = await store.pop(plan.id);
    if (!raw) {
      await store.releaseHash(hash);
      if (receipt) await store.addReceipt(sms.amount.toFixed(2), receipt);
      return send(res, 409, { ok: false, error: 'نفدت بطاقات هذه الباقة حالياً، تواصل مع وسام' });
    }
    const card = JSON.parse(raw);
    await store.addSale({ t: Date.now(), plan: plan.name, price: plan.price, balance: sms.balance, user: card.u, pass: card.p,
                          msg: normalize(b.message).slice(0, 300), ip, receipt: !!receipt });

    /* (هـ) إشعارات تيليجرام: البيعة + تحذير المخزون */
    const left = await store.count(plan.id);
    notify('💰 <b>بيعة جديدة</b>\n━━━━━━━━━━\n' +
      '📦 الباقة: ' + esc(plan.name) + ' (' + plan.price + ' شيكل)\n' +
      '👤 اليوزر: <code>' + esc(card.u) + '</code>\n' +
      '🔑 الباسورد: <code>' + esc(card.p) + '</code>\n━━━━━━━━━━\n' +
      '💳 رسالة الدفع:\n<code>' + esc(normalize(b.message).slice(0, 300)) + '</code>\n' +
      '💵 رصيد الزبون بعد الدفع: ' + sms.balance.toFixed(2) + ' ILS\n' +
      (receipt ? '✅ تم تأكيد الاستلام من جوالك\n' : '⚠️ بدون تأكيد استلام (الرسالة من الزبون فقط)\n') +
      '🌐 IP: ' + esc(ip) + '\n🕐 ' + fmtDT(Date.now()));
    if (left <= LOW_STOCK) {
      notify((left === 0 ? '🚨 <b>نفد مخزون باقة ' : '⚠️ <b>مخزون قليل: باقة ') + esc(plan.name) + '</b>\nالمتبقي: <b>' + left + '</b> بطاقة',
        { inline_keyboard: [[{ text: '➕ إضافة بطاقات لهذه الباقة', callback_data: 'a:' + plan.id }]] });
    }
    return send(res, 200, { ok: true, plan: plan.name, username: card.u, password: card.p });
  }

  /* --- webhook: إشعار استلام الدفعة من جوالك (تطبيق SMS Forwarder) --- */
  if (p === '/api/incoming' && req.method === 'POST') {
    const b = await bodyObj(req);
    const secret = req.headers['x-secret'] || b.secret || u.searchParams.get('secret') || '';
    if (!INCOMING_SECRET || !eq(secret, INCOMING_SECRET)) return send(res, 401, { ok: false });
    const msg = normalize(b.message || b.text || b.body || '');
    if (/تم\s*تحويل/.test(msg)) return send(res, 200, { ok: true, ignored: 'outgoing' });   // رسالة تحويل صادرة
    const m = msg.match(/ILS\s*([\d,]+(?:\.\d+)?)/i);
    if (!m) return send(res, 200, { ok: true, ignored: 'no amount' });
    await store.addReceipt(num(m[1]).toFixed(2), { t: Date.now() });
    return send(res, 200, { ok: true });
  }

  /* --- من الراوتر: إشارة حياة (كل دقيقة) --- */
  if (p === '/api/hs/heartbeat' && req.method === 'POST') {
    const b = await bodyObj(req);
    if (!isRouter(req, b)) return send(res, 401, { ok: false });
    const prevIp = router.ip, wasOffline = router.offlineNotified;
    router.t = Date.now(); router.ip = ip;                            // IP العام = كما يشوفه السيرفر
    if (b.hs_ip) router.hsIp = String(b.hs_ip).slice(0, 45);
    if (b.wan_ip) router.wanIp = String(b.wan_ip).slice(0, 45);
    if (b.uptime) router.uptime = Number(b.uptime) || 0;
    if (b.clients != null) router.clients = String(b.clients).slice(0, 8);
    router.offlineNotified = false;
    if (wasOffline) notify('🟢 <b>الراوتر رجع اتصل</b>\n🌍 IP العام: <code>' + esc(ip) + '</code>\n🕐 ' + fmtDT(router.t));
    else if (prevIp && prevIp !== ip) notify('🔄 <b>تغيّر IP العام للراوتر</b>\nالقديم: <code>' + esc(prevIp) + '</code>\nالجديد: <code>' + esc(ip) + '</code>');
    return send(res, 200, { ok: true });
  }

  /* --- من صفحة الدخول: زبون فتح الصفحة (بنعرف IP العام + عنوان الهوتسبت) --- */
  if (p === '/api/hs/ping' && req.method === 'POST') {
    const b = await bodyObj(req);
    router.portal = { t: Date.now(), ip, host: String(b.host || '').slice(0, 60) };
    return send(res, 200, { ok: true });
  }

  /* --- من صفحة الدخول: الزبون ضغط "اتصال" (بنتأكد إنو اليوزر والباسورد بطاقة حقيقية) ---
     الرد دايماً نفسه (ok) حتى ما يصير هاد الـ API وسيلة لتخمين الباسوردات */
  if (p === '/api/portal/login' && req.method === 'POST') {
    const b = await bodyObj(req);
    send(res, 200, { ok: true });
    if (limited('pl:' + ip, 100, 10 * 60 * 1000)) return;
    const user = String(b.user || '').slice(0, 64), pass = String(b.pass || '').slice(0, 64);
    if (!user) return;
    const info = await lookupCard(user);
    if (info && info.pass && eq(info.pass, pass)) await onLogin(user, '', '', devName(req.headers['user-agent']));
    return;
  }

  /* --- صفحة المراقبة (تفتحها على جهاز متصل بالهوتسبت) --- */
  if (p === '/monitor') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'monitor.html')));
  }

  /* --- من الراوتر: يوزر سجّل دخول (CoovaChilli conup) - اختياري، بس إذا صار عندك صلاحية على الراوتر --- */
  if (p === '/api/hs/login' && req.method === 'POST') {
    const b = await bodyObj(req);
    if (!isRouter(req, b)) return send(res, 401, { ok: false });
    const first = await onLogin(String(b.user || '').slice(0, 64), String(b.mac || '').slice(0, 20), String(b.ip || '').slice(0, 45));
    return send(res, 200, { ok: true, first });
  }

  /* --- تيليجرام webhook --- */
  if (p === '/tg' && req.method === 'POST') {
    if (!TG_TOKEN || !eq(req.headers['x-telegram-bot-api-secret-token'] || '', TG_SECRET)) return send(res, 401, { ok: false });
    const upd = await bodyObj(req);
    send(res, 200, { ok: true });                                     // نرد فوراً، والمعالجة بالخلفية
    onTelegram(upd).catch(e => console.error('tg handler', e));
    return;
  }

  /* --- صفحة المدير + API المدير --- */
  if (p === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
  }
  if (p === '/api/admin/summary' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { ok: false });
    const stock = {}, cards = {};
    for (const pl of PLANS) { cards[pl.id] = (await store.list(pl.id)).map(x => JSON.parse(x)); stock[pl.id] = cards[pl.id].length; }
    const actsList = Object.values(acts).sort((a, b) => b.t - a.t).slice(0, 100);
    return send(res, 200, { ok: true, plans: PLANS, stock, cards, sales: await store.sales(100), acts: actsList, router });
  }
  if (p === '/api/admin/cards' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { ok: false });
    const b = await bodyObj(req);
    const plan = PLANS.find(x => x.id === b.planId);
    if (!plan) return send(res, 400, { ok: false, error: 'باقة غير صحيحة' });
    const r = await addCards(plan.id, b.text);
    return send(res, 200, { ok: true, added: r.added, dup: r.dup, bad: r.bad, stock: r.stock });
  }

  send(res, 404, { ok: false });
}

/* ==========================================================================
   10) تشغيل السيرفر
   ========================================================================== */
(async () => {
  try { await loadActs(); await migrateMeta(); } catch (e) { console.error('startup', e.message); }
  http.createServer((req, res) => {
    handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { ok: false, error: 'خطأ بالسيرفر' }); });
  }).listen(PORT, () => console.log('Server on', PORT));
  setupTelegram();
  setInterval(() => tick().catch(e => console.error('tick', e.message)), TICK_MS).unref();
})();
