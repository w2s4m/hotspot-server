const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let users = {};
let pending = {};

// غير هاد الرقم لرقمك
const MY_JAWWAL_PAY = "0599747574"; // <-- حط رقمك هون

app.get('/', (req, res) => {
  res.send(`
  <div style="font-family:Arial; text-align:center; direction:rtl; padding:20px">
  <h2>🔥 Hotspot - واي فاي</h2>
  <p>اختار باقة وحول على Jawwal Pay</p>
  <form action="/pay" method="POST">
    <select name="package" style="padding:10px; font-size:16px">
      <option value="1h-5">ساعة - 5 شيكل</option>
      <option value="1d-10">يوم كامل - 10 شيكل</option>
      <option value="7d-25">اسبوع - 25 شيكل</option>
      <option value="30d-60">شهر - 60 شيكل</option>
    </select><br><br>
    رقم جوالك: <br><input name="phone" placeholder="0599xxxxxx" required style="padding:10px"><br><br>
    <button style="padding:12px 20px; background:#e4002b; color:white; border:none; font-size:16px">كمل الدفع</button>
  </form>
  </div>
  `);
});

app.post('/pay', (req, res) => {
  const { phone, package } = req.body;
  const price = package.split('-')[1];
  res.send(`
  <div style="font-family:Arial; text-align:center; direction:rtl; padding:20px">
  <h2>حول ${price} شيكل على Jawwal Pay</h2>
  <p style="font-size:22px">الرقم: <b>${MY_JAWWAL_PAY}</b></p>
  <p>1. افتح تطبيق Jawwal Pay<br>2. حول ${price} شيكل على الرقم اللي فوق<br>3. انسخ رقم العملية اللي بيوصلك برسالة</p>
  <form action="/confirm" method="POST">
    <input type="hidden" name="phone" value="${phone}">
    <input type="hidden" name="package" value="${package}">
    رقم العملية: <br><input name="txid" placeholder="مثال: 123456789" required style="padding:10px"><br><br>
    <button style="padding:12px 20px; background:green; color:white; border:none">تأكيد الدفع</button>
  </form>
  </div>
  `);
});

app.post('/confirm', (req, res) => {
  const user = 'hs_' + Math.floor(1000 + Math.random()*9000);
  const pass = Math.floor(1000 + Math.random()*9000);
  users[user] = { pass, package: req.body.package, phone: req.body.phone, txid: req.body.txid };
  res.send(`<div style="text-align:center; direction:rtl; font-family:Arial; padding:20px"><h2>تم ✅</h2><p>رقم العملية: ${req.body.txid}</p><h3>يوزر: ${user}<br>باسورد: ${pass}</h3><p>ارجع على صفحة الواي فاي وحطهم</p></div>`);
});

app.get('/auth', (req, res) => {
  const { user, pass } = req.query;
  if(users[user] && users[user].pass == pass) return res.send('OK');
  res.send('FAIL');
});

app.get('/admin', (req, res) => {
  let html = '<h2>الزباين اللي دفعوا</h2>';
  for(let u in users) html += `${u} - ${users[u].pass} - ${users[u].phone} - ${users[u].txid}<br>`;
  res.send(html);
});

app.listen(process.env.PORT || 8080, () => console.log('running'));
`);
