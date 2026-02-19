---
description: How to set up Telegram forwarding for X/Twitter alerts to the trading dashboard
---

# Telegram Forwarding Setup for X Alerts

This workflow sets up automatic forwarding of X/Twitter alerts from specific accounts into your trading dashboard for validation.

## Prerequisites
- A Telegram account
- Your existing Telegram bot (already configured in `.env`)
- An ngrok or similar tunnel (for receiving webhooks if running locally)

## Option 1: RSS.app (Easiest — Free Tier)

### Step 1: Create RSS Feed from X Account
1. Go to [rss.app](https://rss.app)
2. Sign up for a free account
3. Click **"New Feed"** → **"Website"**
4. Enter the X profile URL: `https://x.com/greatstockpicks` (or `https://x.com/millionaire_555`)
5. RSS.app will generate an RSS feed URL — copy it

### Step 2: Connect RSS to Webhook
1. Go to [make.com](https://make.com) (free tier = 1000 operations/month)
2. Create a new scenario:
   - **Trigger**: RSS → Watch RSS Feed Items
   - Paste your RSS.app feed URL
   - Set check interval to **1 minute**
   - **Action**: HTTP → Make a Request
     - URL: `http://YOUR_SERVER:3000/webhook/x-alert`
     - Method: POST
     - Body type: JSON
     - Body:
     ```json
     {
       "ticker": "",
       "source": "greatstockpicks",
       "text": "{{title}} {{description}}"
     }
     ```
3. The dashboard will auto-extract `$TICKER` from the text
4. Click **"Run Once"** to test, then activate the scenario

> **Note:** If running locally, use ngrok: `ngrok http 3000` to get a public URL

## Option 2: Telegram Bot + Channel (More Control)

### Step 1: Create a Telegram Channel for X Alerts
1. Open Telegram → New Channel → Name it "X Trading Alerts"
2. Add your bot as an admin (the bot token in your `.env`)

### Step 2: Set Up IFTTT to Post X Tweets to Telegram
1. Go to [ifttt.com](https://ifttt.com) — free tier supports this
2. Create an Applet:
   - **If This**: Twitter → New tweet by a specific user
   - Enter: `greatstockpicks`
   - **Then That**: Webhook
   - URL: `http://YOUR_SERVER:3000/webhook/x-alert`
   - Method: POST
   - Content Type: `application/json`
   - Body: `{"text": "{{Text}}", "source": "greatstockpicks"}`
3. Repeat for `millionaire_555`

### Step 3: Test It
// turbo
```
curl -X POST http://localhost:3000/webhook/x-alert -H "Content-Type: application/json" -d "{\"text\": \"$FGL looking great, micro float sub 2M shares, heavy volume\", \"source\": \"greatstockpicks\"}"
```

## Option 3: Manual Telegram Bot Polling (Self-Hosted, No External Services)

### Step 1: Forward Tweets to Your Telegram Bot
1. Install the Chrome extension **"Tweet to Telegram"** or use a service like [TweetShift](https://tweetshift.com)
2. Configure it to forward tweets from target accounts to your Telegram bot

### Step 2: Set Up Bot Webhook
Add this to your server startup to poll your Telegram bot for forwarded messages. The dashboard already handles the `/webhook/x-alert` endpoint.

You can also simply set a Telegram webhook:
// turbo
```
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=http://YOUR_SERVER:3000/webhook/telegram-forward"
```

## Testing the Full Pipeline

### Test 1: Manual Dashboard Validation
1. Open http://localhost:3000
2. Scroll to **🎯 X Alert Validator**
3. Type `FGL` in the ticker field
4. Click **Validate**
5. You should see: Score, Price, Shares Outstanding, Float, SI%, Targets

### Test 2: Webhook Test
// turbo
```
curl -X POST http://localhost:3000/webhook/x-alert -H "Content-Type: application/json" -d "{\"ticker\": \"QCNX\", \"source\": \"millionaire_555\", \"text\": \"QCNX micro float runner\"}"
```

### Test 3: Auto Ticker Extraction
// turbo
```
curl -X POST http://localhost:3000/webhook/x-alert -H "Content-Type: application/json" -d "{\"text\": \"$NBIS is setting up nicely, low float play\", \"source\": \"X/Telegram\"}"
```

The system auto-extracts `$NBIS` from the text when no ticker is provided.

## Webhook Endpoint Reference

| Endpoint | Method | Body |
|---|---|---|
| `/api/validate-ticker` | POST | `{ "ticker": "FGL", "source": "Manual" }` |
| `/webhook/x-alert` | POST | `{ "ticker": "FGL", "source": "greatstockpicks", "text": "..." }` |
| `/api/x-alerts` | GET | Returns all validated alerts |
