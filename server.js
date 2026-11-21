const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
let users = {};
app.post('/confirm', (req,res)=>{
  const user = 'WESAM' + Math.floor(1000+Math.random()*9000);
  const pass = ''+Math.floor(1000+Math.random()*9000);
  users[user]={pass, ...req.body, time: Date.now()};
  console.log('NEW PAY:', req.body, user, pass);
  res.json({user, pass});
});
app.get('/auth', (req,res)=>{
  const {user, pass} = req.query;
  if(users[user] && users[user].pass==pass) return res.send('OK');
  res.send('FAIL');
});
app.get('/admin', (req,res)=>{
  let h='<h2>دفعات Jawwal Pay</h2>';
  for(let u in users) h+=`${u} - ${users[u].pass} - ${users[u].phone} - ${users[u].txid} - ${users[u].package}<br>`;
  res.send(h);
});
app.get('/', (req,res)=>res.send('WESAM TECH Server is UP'));
app.listen(process.env.PORT||8080);
