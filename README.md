# Bike Remittance Tracker – automatic M-Pesa server

Receives payments automatically and shows them in the dashboard (same app as the claude.ai page).
Zero dependencies, Node 18+.

## 1. Run it
    cp .env.example .env      # set ADMIN_PASSWORD and WEBHOOK_SECRET (long random, letters/digits only)
    node --env-file=.env server.js
Open http://localhost:3000 and log in (user `admin`). Add bikes; each rider's phone must be saved in the bike profile.
It must be reachable on a public HTTPS URL (VPS, Railway, Render, Fly.io, or `ngrok http 3000` for testing).
**Keep data.json on a persistent disk/volume** – free tiers that wipe the disk will lose your records. Back it up.

## 2. Path A – works NOW with your personal number +254713657634 (SMS forwarding)
A personal number cannot use Daraja. Instead, install an SMS-forwarder app on the phone that holds that SIM
(e.g. "SMS Forwarder" / "SMS to URL forwarder" from Play Store), filter senders to **MPESA**, and POST each SMS to:

    https://YOUR-SERVER/sms/YOUR_WEBHOOK_SECRET
    body (JSON):  {"message":"%body%"}      (or plain text / form field "message")

Every "You have received KshX from NAME 07XX…" SMS is parsed, matched to the bike by the rider's phone, and
recorded with the real M-Pesa time. Duplicates (same M-Pesa code) are ignored. Keep the phone on, with data and
battery optimisation off for the forwarder app.

## 3. Path B – Daraja C2B (needs a Paybill or Till number, not a personal number)
1. Get a Till/Paybill from Safaricom and create an app at developer.safaricom.co.ke; go live for production.
2. Fill DARAJA_* , SHORTCODE and BASE_URL in .env, then run: `node --env-file=.env register.js`
   (registers /pay/confirm/<secret> and /pay/validate/<secret>; Safaricom rejects URLs containing "mpesa").
3. Riders then pay to your Till/Paybill. With Paybill, tell riders to use the **number plate as the account number**
   – that matches the bike even if they pay from another phone. Daraja v2 hides phone numbers (SHA-256 hashed);
   the server handles that automatically.

## Unmatched payments
Anything that can't be linked to a bike (new phone, wrong account) lands in **Payments → Unmatched**. Assign it to a bike
with one click and it is back-dated like any other payment.

## Security
Dashboard/API need the admin login (use HTTPS). Webhooks need the secret in the URL. Never share the secret.

## Daily SMS reminders
Riders who owe money (missed days or part-payment, Mon-Sat counting) get an SMS such as:
"Hi John, bike KMEA123A: you owe KES 1,000 (2 days). Please pay KES 500 daily to +254713657634. Thank you."
1. Create an Africa's Talking account, get a sender ID if you want a name instead of a number (optional), and top up airtime.
2. In .env set AT_ENV=production, AT_USERNAME, AT_API_KEY, REMIND_ENABLED=1 and REMIND_TIME (Nairobi time, default 17:00).
3. The server sends automatically once a day, never on Sundays, and texts you (ADMIN_PHONE) a summary of who was reminded.
4. Dashboard -> "Send reminders" shows who would be texted and asks you to confirm before sending.
Riders who have paid, or are ahead, are never texted. Tell riders up front that they will receive these messages.
