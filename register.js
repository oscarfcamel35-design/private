// One-off: registers your callback URLs with Safaricom (Paybill/Till only). Run: node --env-file=.env register.js
const P=process.env,base=P.DARAJA_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
(async()=>{
  const t=await(await fetch(base+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+Buffer.from(P.DARAJA_KEY+':'+P.DARAJA_SECRET).toString('base64')}})).json();
  const r=await fetch(base+'/mpesa/c2b/v2/registerurl',{method:'POST',headers:{Authorization:'Bearer '+t.access_token,'Content-Type':'application/json'},
    body:JSON.stringify({ShortCode:P.SHORTCODE,ResponseType:'Completed',ConfirmationURL:`${P.BASE_URL}/pay/confirm/${P.WEBHOOK_SECRET}`,ValidationURL:`${P.BASE_URL}/pay/validate/${P.WEBHOOK_SECRET}`})});
  console.log(r.status,await r.text())})();
