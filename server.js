// Bike Remittance Tracker server: receives M-Pesa payments automatically and serves the dashboard.
// Zero dependencies. Requires Node 18+.  Run: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const P=process.env,PORT=P.PORT||3000,FILE=P.DATA_FILE||path.join(__dirname,'data.json');
const SECRET=P.WEBHOOK_SECRET,USER=P.ADMIN_USER||'admin',PASS=P.ADMIN_PASSWORD;
if(!PASS||!SECRET){console.error('Set ADMIN_PASSWORD and WEBHOOK_SECRET (see .env.example)');process.exit(1)}
const COLS=['bikes','payments','services','unmatched'];
let D={bikes:{},payments:{},services:{},unmatched:{},meta:{}};
try{D={...D,...JSON.parse(fs.readFileSync(FILE,'utf8'))}}catch{}
const persist=()=>{fs.writeFileSync(FILE+'.tmp',JSON.stringify(D));fs.renameSync(FILE+'.tmp',FILE)};
const norm=p=>{p=String(p||'').replace(/\D/g,'');return p.startsWith('254')?p:p.startsWith('0')?'254'+p.slice(1):p};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const plate=p=>String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const safeEq=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};

// ---- match a payment to a bike: plate in account field > phone > SHA-256 hashed phone (Daraja v2) > masked digits
function findBike({phone,hash,masked,account}){
  const bikes=Object.entries(D.bikes).map(([id,b])=>({id,...b}));
  if(account){const b=bikes.find(b=>b.id===plate(account));if(b)return b}
  if(phone){const b=bikes.find(b=>norm(b.phone)===norm(phone));if(b)return b}
  if(hash){const h=String(hash).toLowerCase();const b=bikes.find(b=>sha(norm(b.phone))===h);if(b)return b}
  if(masked){const m=bikes.filter(b=>norm(b.phone).endsWith(masked));if(m.length===1)return m[0]}
  return null}

function record(x){ // x: {ref,amount,ts,payer,phone,hash,masked,account,src}
  if(!x.ref||!(x.amount>0))return 'ignored';
  if(D.payments[x.ref]||D.unmatched[x.ref])return 'duplicate';
  const b=findBike(x);
  if(b){D.payments[x.ref]={bike:b.id,amount:x.amount,ts:x.ts,ref:x.ref,payer:x.payer||b.rider,src:x.src}}
  else D.unmatched[x.ref]={amount:x.amount,ts:x.ts,ref:x.ref,payer:x.payer||x.phone||'Unknown',src:x.src};
  persist();console.log(new Date().toISOString(),b?'matched '+b.id:'UNMATCHED',x.ref,x.amount);return b?'matched':'unmatched'}

// ---- Daraja C2B confirmation (Paybill / Till)
function fromDaraja(j){
  const t=String(j.TransTime||'');let ts=Date.now();
  if(t.length>=14)ts=new Date(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}+03:00`).getTime();
  const m=String(j.MSISDN||''),plain=/^\+?2547\d{8}$|^2541\d{8}$/.test(m);
  return{ref:j.TransID,amount:+j.TransAmount,ts,payer:[j.FirstName,j.MiddleName,j.LastName].filter(Boolean).join(' '),
    phone:plain?m:'',hash:plain?'':m,account:j.BillRefNumber,src:'daraja'}}

// ---- SMS forwarding (works with a personal number): parse the M-Pesa "received" text
function fromSMS(t){
  if(!/confirmed/i.test(t)||!/received/i.test(t))return null;
  const ref=(t.match(/\b([A-Z0-9]{10})\b\s+Confirmed/i)||[])[1],
    amount=+((t.match(/Ksh\.?\s?([\d,]+(?:\.\d+)?)/i)||[])[1]||'').replace(/,/g,''),
    phone=(t.match(/(?:\+?254|0)[17]\d{8}/)||[])[0],masked=(t.match(/2547\*+(\d{3,4})/)||[])[1],
    dm=t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/),tm=t.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
  let ts=Date.now();
  if(dm){let y=+dm[3];if(y<100)y+=2000;let h=0,mi=0;if(tm){h=+tm[1]%12+(/pm/i.test(tm[3])?12:0);mi=+tm[2]}
    const z=n=>String(n).padStart(2,'0');ts=new Date(`${y}-${z(dm[2])}-${z(dm[1])}T${z(h)}:${z(mi)}:00+03:00`).getTime()}
  const nm=(t.match(/from\s+(.+?)\s+(?:\+?254|0)?[17]\d{8}/i)||t.match(/from\s+(?:\+?254[\d*]+\s+)?([A-Z][A-Z .'-]+?)\s+on\b/i)||[])[1];
  const acc=(t.match(/for account\s+([A-Z0-9 -]+?)\s+on\b/i)||[])[1];
  return{ref,amount,ts,payer:nm&&nm.trim(),phone,masked,account:acc,src:'sms'}}

const body=req=>new Promise(r=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6)req.destroy()});req.on('end',()=>r(b))});
const send=(res,c,o,t='application/json')=>{res.writeHead(c,{'Content-Type':t});res.end(typeof o==='string'?o:JSON.stringify(o))};

// ---- Daily reminders: SMS riders who owe money (Africa's Talking). Mon-Sat only.
const PAYTO=P.PAYTO||'+254713657634',nairobi=(t=Date.now())=>new Date(t+3*36e5).toISOString();
const today=()=>nairobi().slice(0,10);
function owing(){
  const t=new Date(today()+'T00:00:00Z'),out=[];
  for(const[id,b]of Object.entries(D.bikes)){
    const daily=+b.daily||1,paid=Object.values(D.payments).filter(p=>p.bike===id).reduce((a,p)=>a+p.amount,0);
    let n=0;for(let d=new Date(b.start+'T00:00:00Z');d<=t;d=new Date(+d+864e5))if(d.getUTCDay()!==0)n++;
    const owes=n*daily-paid;if(owes<=0||!b.phone)continue;
    const days=Math.ceil(owes/daily),first=(b.rider||'Rider').split(' ')[0];
    out.push({plate:id,rider:b.rider,phone:'+'+norm(b.phone),owes,days,
      message:`Hi ${first}, bike ${id}: you owe KES ${Math.round(owes).toLocaleString('en-KE')} (${days} day${days>1?'s':''}). Please pay KES ${daily} daily to ${PAYTO}. Thank you.`})}
  return out}
async function sms(to,message){
  const base=P.AT_ENV==='production'?'https://api.africastalking.com':'https://api.sandbox.africastalking.com';
  const f=new URLSearchParams({username:P.AT_USERNAME,to,message});if(P.AT_SENDER)f.set('from',P.AT_SENDER);
  const r=await fetch(base+'/version1/messaging',{method:'POST',headers:{apiKey:P.AT_API_KEY,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:f});
  return r.ok}
async function remind(dry){
  const list=owing();if(dry||!list.length)return{count:list.length,list};
  if(!P.AT_USERNAME||!P.AT_API_KEY)return{count:list.length,list,sent:0,note:'SMS not configured: set AT_USERNAME and AT_API_KEY in .env'};
  let sent=0;for(const x of list){try{if(await sms(x.phone,x.message))sent++}catch(e){console.error(e)}}
  if(P.ADMIN_PHONE)try{await sms(P.ADMIN_PHONE,`Reminders sent to ${sent}/${list.length}: `+list.map(x=>x.plate).join(', '))}catch{}
  console.log('reminders',sent,'/',list.length);return{count:list.length,list,sent}}
setInterval(()=>{const day=today();if(P.REMIND_ENABLED!=='1'||nairobi().slice(11,16)!==(P.REMIND_TIME||'17:00'))return;
  if(new Date(day+'T00:00:00Z').getUTCDay()===0||D.meta.lastReminder===day)return;
  D.meta.lastReminder=day;persist();remind(false).catch(console.error)},30000);

http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x'),seg=u.pathname.split('/').filter(Boolean);
    if(u.pathname==='/health')return send(res,200,{ok:true});
    // webhooks (secret in URL). NB: Safaricom rejects callback URLs containing words like "mpesa", hence /pay/.
    if(req.method==='POST'&&(seg[0]==='pay'||seg[0]==='sms')){
      if(!safeEq(seg[seg[0]==='pay'?2:1]||'',SECRET))return send(res,403,{error:'forbidden'});
      const raw=await body(req);
      if(seg[0]==='pay'){let j={};try{j=JSON.parse(raw)}catch{}
        if(seg[1]==='confirm')console.log('daraja',record(fromDaraja(j)));
        return send(res,200,{ResultCode:0,ResultDesc:'Accepted'})}
      let txt=raw;try{const j=JSON.parse(raw);txt=j.message||j.body||j.text||j.content||j.sms||raw}catch{
        const q=new URLSearchParams(raw);txt=q.get('message')||q.get('body')||q.get('text')||raw}
      const x=fromSMS(String(txt));return send(res,200,{result:x?record(x):'not an M-Pesa receipt'})}
    // everything else: admin login (HTTP Basic)
    const[,cred]=(req.headers.authorization||'').split(' '),[du,dp]=Buffer.from(cred||'','base64').toString().split(/:(.*)/s);
    if(!(safeEq(du||'',USER)&safeEq(dp||'',PASS))){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Bike tracker"'});return res.end('Login required')}
    if(u.pathname==='/')return send(res,200,fs.readFileSync(path.join(__dirname,'public/index.html')),'text/html; charset=utf-8');
    if(req.method==='GET'&&u.pathname==='/api/backup'){res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="bike-backup-'+today()+'.json"'});return res.end(JSON.stringify(D,null,1))}
    if(req.method==='POST'&&u.pathname==='/api/remind')return send(res,200,await remind(u.searchParams.get('dry')==='1'));
    if(seg[0]==='api'&&COLS.includes(seg[1])){
      const c=D[seg[1]];
      if(req.method==='GET'&&!seg[2])return send(res,200,Object.entries(c).map(([id,v])=>({id,...v})));
      if(req.method==='PUT'&&seg[2]){c[seg[2]]=JSON.parse(await body(req));persist();return send(res,200,{ok:true})}
      if(req.method==='DELETE'&&seg[2]){delete c[seg[2]];persist();return send(res,200,{ok:true})}}
    send(res,404,{error:'not found'})
  }catch(e){console.error(e);send(res,500,{error:'server error'})}
}).listen(PORT,()=>console.log('Bike tracker on :'+PORT));
