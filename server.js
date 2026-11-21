const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let users = {};

app.get('/', (req, res) => {
  res.send(`
  <h2>🔥 Hotspot - اختار باقة</h2>
  <form action="/pay" method="POST">
    <select name="package">
      <option value="1h-5">ساعة - 5 شيكل</option>
      <option value="1d-10">يوم - 10 شيكل</option>
      <option value="7d-25">اسبوع - 25 شيكل</option>
    </select><br><br>
    رقم الجوال: <input name="phone" placeholder="0599xxxxxx" required><br><br>
    <button>ادفع بـ Jawwal Pay / PalPay</button>
  </form>
  `);
});

app.post('/pay', (req, res) => {
  const user = 'hs_' + Math.floor(1000 + Math.random()*9000);
  const pass = Math.floor(1000 + Math.random()*9000);
  users[user] = { pass, package: req.body.package, phone: req.body.phone };
  res.send(`<h2>تم الدفع بنجاح ✅</h2><p>يوزر: <b>${user}</b><br>باسورد: <b>${pass}</b></p><p>ارجع على صفحة الواي فاي وحطهم</p>`);
});

app.get('/auth', (req, res) => {
  // هون الراوتر بيسأل السيرفر: هاد اليوزر صح؟
  const { user, pass } = req.query;
  if(users[user] && users[user].pass == pass) return res.send('OK');
  res.send('FAIL');
});

app.listen(process.env.PORT || 8080, () => console.log('running'));