#!/bin/bash
# ============================================
# Trading Command Centre — VPS Deploy Script
# Run this ON the VPS after SSH-ing in
# ============================================
set -e

echo "🚀 Starting Trading Command Centre Deployment..."

# 1. System Update
echo "📦 Updating system packages..."
apt update && apt upgrade -y

# 2. Install Node.js 20.x
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Install PM2 + Git
echo "📦 Installing PM2 and Git..."
npm install -g pm2
apt install -y git

# 4. Clone Repository
echo "📥 Cloning Command Centre from GitHub..."
cd /root
if [ -d "Command-Centre" ]; then
    echo "Directory exists, pulling latest..."
    cd Command-Centre
    git pull
else
    git clone https://github.com/Tox2025/Command-Centre.git
    cd Command-Centre
fi

# 5. Install Dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# 6. Create data directory
mkdir -p data

# 7. Open Firewall Port 3000
echo "🔓 Opening firewall ports..."
ufw allow OpenSSH
ufw allow 3000
echo "y" | ufw enable

# 8. Create .env template
if [ ! -f ".env" ]; then
    echo "📝 Creating .env template..."
    cat > .env << 'ENVFILE'
# === TRADING COMMAND CENTRE CONFIG ===
# REQUIRED: Unusual Whales API Key
UW_API_KEY=your_key_here

# Server Port
PORT=3000

# Watchlist Tickers (comma-separated)
TICKERS=AAPL,MSFT,NVDA,META,TSLA,AMZN,GOOG

# Discord Webhooks
DISCORD_WEBHOOK_URL=your_webhook_here
DISCORD_BRIEF_WEBHOOK_URL=your_webhook_here
DISCORD_PAPER_WEBHOOK_URL=your_webhook_here

# Telegram
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Gemini AI
GEMINI_API_KEY=your_key_here
ENVFILE
    echo "⚠️  IMPORTANT: Edit .env with your real API keys!"
    echo "   Run: nano .env"
else
    echo "✅ .env already exists, skipping..."
fi

echo ""
echo "============================================"
echo "✅ Deployment Complete!"
echo "============================================"
echo ""
echo "NEXT STEPS:"
echo "  1. Edit .env with your API keys:  nano .env"
echo "  2. Start the bot:                 pm2 start server.js --name trading-bot"
echo "  3. Save PM2 config:               pm2 save && pm2 startup"
echo "  4. View dashboard:                http://142.93.194.149:3000"
echo "  5. View logs:                     pm2 logs trading-bot"
echo ""
