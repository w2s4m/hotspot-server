'use strict';
/* WESAM TECH - Hotspot payment server (بدون أي مكتبات خارجية - Node 18+) */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ================== الإعدادات ================== */
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';               // باسورد صفحة المدير (إجباري)
const SELLER_LAST9 = (process.env.SELLER_NUMBER || '0599747574').replace(/\D/g, '').slice(-9);
const REQUIRE_RECEIPT = process.env.REQUIRE_RECEIPT === 'true'; // true = لازم يوصلك إشعار استلام من جوالك
const INCOMING_SECRET = process.env.INCOMING_SECRET || '';   // سر الـ webhook (لإشعارات الاستلام)
const RECEIPT_MAX_AGE_MIN = Number(process.env.RECEIPT_MAX_AGE_MIN || 30);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';       // اختياري: تنبيهات تيليجرام
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const LOW_STOCK = Number(process.env.LOW_STOCK || 3);         // نبّهني لما يضل هالعدد أو أقل
const HASH_TTL_SEC = 60 * 60 * 24 * 30;                      // الرسالة المستخدمة ما بتنقبل ثاني مرة لمدة 30 يوم

const PLANS = [
  { id: 'd1',  name: '24 ساعة', price: 1 },
  { id: 'd3',  name: '3 أيام',  price: 3 },
  { id: 'd7',  name: 'أسبوع',   price: 7 },
  { id: 'd10', name: '10 أيام', price: 10 },
  { id: 'd30', name: 'شهري',    price: 30 }
];

/* ================== التخزين ==================
   - إذا حطيت UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN => تخزين دائم (مجاني) - مطلوب على Render المجاني
   - غير هيك => ملف data.json (بينمسح مع كل Restart على Render المجاني، للتجربة فقط) */
class FileStore {
  constructor(file) {
    this.f = file;
    this.db = { stock: {}, hashes: {}, sales: [], receipts: {} };
    try { Object.assign(this.db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) {}
  }
  _save() {
    try { fs.writeFileSync(this.f + '.tmp', JSON.stringify(this.db)); fs.renameSync(this.f + '.tmp', this.f); }
    catch (e) { console.error('save error', e.message); }
  }
  async count(p) { return (this.db.stock[p] || []).length; }
  async list(p) { return (this.db.stock[p] || []).slice(); }
  async push(p, arr) { (this.db.stock[p] = this.db.stock[p] || []).push(...arr); this._save(); }
  async pop(p) { const a = this.db.stock[p] || []; const v = a.shift(); this._save(); return v || null; }
  async claimHash(h, ttl) {
    const now = Date.now(), e = this.db.hashes[h];
    if (e && e > now) return false;
    this.db.hashes[h] = now + ttl * 1000; this._save(); return true;
  }
  async releaseHash(h) { delete this.db.hashes[h]; this._save(); }
  async addSale(s) { this.db.sales.unshift(s); if (this.db.sales.length > 1000) this.db.sales.length = 1000; this._save(); }
  async sales(n) { return this.db.sales.slice(0, n); }
  async addReceipt(k, o) { (this.db.receipts[k] = this.db.receipts[k] || []).push(o); this._save(); }
  async popReceipt(k, maxAgeMs) {
    const a = this.db.receipts[k] || [];
    while (a.length) {
      const r = a.shift();
      if (Date.now() - r.t <= maxAgeMs) { this._save(); return r; }
    }
    this._save(); return null;
  }
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
  async pop(p) { return (await this.cmd(['LPOP', 'stock:' + p])) || null; }       // LPOP ذرّي: مستحيل بطاقة تنباع مرتين
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
}

const store = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new RedisStore(process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN)
  : new FileStore(path.join(__dirname, 'data.json'));
console.log('Storage:', store instanceof RedisStore ? 'Upstash Redis (دائم)' : 'File (مؤقت!)');

/* ================== تحليل رسالة جوال باي ==================
   الصيغة المطلوبة بالضبط:
   تم تحويل ILS 6.00 الى 00970599747574 رصيدك الحالي ILS 94.00
   (تحليل صارم بدون ذكاء اصطناعي - أدق وأسرع وما بيغلط ولا بيتخدع بجمل مكتوبة للـ AI) */
function normalize(s) {
  return String(s || '')
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x6F0))
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
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

/* ================== أدوات ================== */
const ipHits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  const a = (ipHits.get(ip) || []).filter(t => now - t < windowMs);
  a.push(now); ipHits.set(ip, a);
  return a.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of ipHits) if (!v.some(t => now - t < 3600000)) ipHits.delete(k); }, 600000).unref();

function eq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function isAdmin(req) { return !!ADMIN_KEY && eq(req.headers['x-admin-key'] || '', ADMIN_KEY); }

function parseCards(text) {
  const out = [], seen = new Set();
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim(); if (!t) return;
    const parts = t.split(/[\s,;:\t|]+/).filter(Boolean);
    const user = parts[0], pass = parts[1] || parts[0];
    if (!user || seen.has(user)) return;
    seen.add(user); out.push(JSON.stringify({ u: user, p: pass }));
  });
  return out;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 50000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
async function bodyObj(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw); } catch (e) {}
  const o = {}; new URLSearchParams(raw).forEach((v, k) => { o[k] = v; }); return o;
}

async function notify(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text })
    });
  } catch (e) { console.error('notify error', e.message); }
}

/* ================== المسارات ================== */
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/' || p === '/health') return send(res, 200, { ok: true, service: 'wesam-tech-hotspot' });

  /* --- الباقات + هل في بطاقات متاحة --- */
  if (p === '/api/plans' && req.method === 'GET') {
    const plans = [];
    for (const pl of PLANS) plans.push({ id: pl.id, name: pl.name, price: pl.price, available: (await store.count(pl.id)) > 0 });
    return send(res, 200, { ok: true, seller: '0' + SELLER_LAST9, plans });
  }

  /* --- شراء بطاقة --- */
  if (p === '/api/buy' && req.method === 'POST') {
    if (limited(ip, 8, 10 * 60 * 1000)) return send(res, 429, { ok: false, error: 'محاولات كتيرة، جرّب بعد شوي' });
    const b = await bodyObj(req);
    const plan = PLANS.find(x => x.id === b.planId);
    if (!plan) return send(res, 400, { ok: false, error: 'باقة غير صحيحة' });

    const sms = parseSms(b.message);
    if (!sms.ok) return send(res, 400, { ok: false, error: sms.error });
    if (Math.abs(sms.amount - plan.price) > 0.001)
      return send(res, 400, { ok: false, error: 'المبلغ بالرسالة (' + sms.amount.toFixed(2) + ' ILS) لا يطابق سعر الباقة (' + plan.price.toFixed(2) + ' ILS)' });
    if (sms.to !== SELLER_LAST9)
      return send(res, 400, { ok: false, error: 'الرسالة محوّلة لرقم غير رقم البائع' });
    if ((await store.count(plan.id)) === 0)
      return send(res, 409, { ok: false, error: 'نفدت بطاقات هذه الباقة حالياً، تواصل مع وسام' });

    const hash = crypto.createHash('sha256').update(sms.amount.toFixed(2) + '|' + sms.to + '|' + sms.balance.toFixed(2)).digest('hex');
    if (!(await store.claimHash(hash, HASH_TTL_SEC)))
      return send(res, 409, { ok: false, error: 'هذه الرسالة مستخدمة من قبل' });

    let receipt = null;
    if (REQUIRE_RECEIPT) {
      receipt = await store.popReceipt(sms.amount.toFixed(2), RECEIPT_MAX_AGE_MIN * 60000);
      if (!receipt) {
        await store.releaseHash(hash);
        return send(res, 402, { ok: false, error: 'لم يصلنا تأكيد استلام الدفعة بعد. انتظر دقيقة وحاول مرة ثانية' });
      }
    }

    const raw = await store.pop(plan.id);   // السحب بيحذف البطاقة من المخزون فوراً
    if (!raw) {
      await store.releaseHash(hash);
      if (receipt) await store.addReceipt(sms.amount.toFixed(2), receipt);
      return send(res, 409, { ok: false, error: 'نفدت بطاقات هذه الباقة حالياً، تواصل مع وسام' });
    }
    const card = JSON.parse(raw);
    await store.addSale({ t: Date.now(), plan: plan.name, price: plan.price, balance: sms.balance, user: card.u, pass: card.p, msg: normalize(b.message).slice(0, 300), ip, receipt: !!receipt });
    const left = await store.count(plan.id);
    notify(
      '💰 بيعة جديدة\n' +
      '━━━━━━━━━━━━\n' +
      '📦 الباقة: ' + plan.name + ' (' + plan.price + ' شيكل)\n' +
      '👤 اليوزر: ' + card.u + '\n' +
      '🔑 الباسورد: ' + card.p + '\n' +
      '━━━━━━━━━━━━\n' +
      '💳 رسالة الدفع:\n' + normalize(b.message).slice(0, 300) + '\n' +
      '💵 رصيد الزبون بعد الدفع: ' + sms.balance.toFixed(2) + ' ILS\n' +
      (receipt ? '✅ تم تأكيد الاستلام من جوالك\n' : '⚠️ بدون تأكيد استلام (الرسالة من الزبون فقط)\n') +
      '🌐 IP: ' + ip + '\n' +
      '━━━━━━━━━━━━\n' +
      '📊 المتبقي من هذه الباقة: ' + left +
      (left === 0 ? '\n🚨 نفد المخزون!' : left <= LOW_STOCK ? '\n⚠️ المخزون قليل، أضف بطاقات' : '')
    );
    return send(res, 200, { ok: true, plan: plan.name, username: card.u, password: card.p });
  }

  /* --- webhook: إشعار استلام الدفعة من جوال وسام (SMS Forwarder) --- */
  if (p === '/api/incoming' && req.method === 'POST') {
    const b = await bodyObj(req);
    const secret = req.headers['x-secret'] || b.secret || u.searchParams.get('secret') || '';
    if (!INCOMING_SECRET || !eq(secret, INCOMING_SECRET)) return send(res, 401, { ok: false });
    const msg = normalize(b.message || b.text || b.body || '');
    if (/تم\s*تحويل/.test(msg)) return send(res, 200, { ok: true, ignored: 'outgoing' });
    const m = msg.match(/ILS\s*([\d,]+(?:\.\d+)?)/i);
    if (!m) return send(res, 200, { ok: true, ignored: 'no amount' });
    await store.addReceipt(num(m[1]).toFixed(2), { t: Date.now() });
    return send(res, 200, { ok: true });
  }

  /* --- المدير --- */
  if (p === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
  }
  if (p === '/api/admin/summary' && req.method === 'GET') {
    if (!isAdmin(req)) return send(res, 401, { ok: false });
    const stock = {};
    const cards = {};
    for (const pl of PLANS) {
      const list = (await store.list(pl.id)).map(x => JSON.parse(x));
      cards[pl.id] = list; stock[pl.id] = list.length;
    }
    return send(res, 200, { ok: true, plans: PLANS, stock, cards, sales: await store.sales(100) });
  }
  if (p === '/api/admin/cards' && req.method === 'POST') {
    if (!isAdmin(req)) return send(res, 401, { ok: false });
    const b = await bodyObj(req);
    const plan = PLANS.find(x => x.id === b.planId);
    if (!plan) return send(res, 400, { ok: false, error: 'باقة غير صحيحة' });
    const existing = new Set((await store.list(plan.id)).map(x => JSON.parse(x).u));
    const fresh = parseCards(b.text).filter(x => !existing.has(JSON.parse(x).u));
    await store.push(plan.id, fresh);
    return send(res, 200, { ok: true, added: fresh.length, stock: await store.count(plan.id) });
  }

  send(res, 404, { ok: false });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { ok: false, error: 'خطأ بالسيرفر' }); });
}).listen(PORT, () => console.log('Server on', PORT));
