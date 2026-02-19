---
description: How to set up IBKR TWS/Gateway on the VPS for real-time tick data and trading API
---

# IBKR TWS Setup on VPS

## Prerequisites
- IBKR account (already have)
- VPS with root access (DigitalOcean Command-Centre)

## Step 1: Subscribe to Market Data (on ibkr.com)
1. Log in to [ibkr.com](https://www.ibkr.com)
2. Go to **Account Management** → **Settings** → **Market Data Subscriptions**
3. Subscribe to **"US Securities Snapshot and Streaming Bundle"** — $10/mo (waived if commissions > $30/mo)
4. This enables: real-time Level 1, Level 2, tick-by-tick trades

## Step 2: Enable API Access (on ibkr.com)
1. **Account Management** → **Settings** → **API** → **API Settings**
2. Ensure **"Enable API"** is checked
3. Note your account ID

## Step 3: Install IB Gateway on VPS
SSH into VPS and run:

```bash
# Install Java (required by IB Gateway)
// turbo
apt update && apt install -y default-jre xvfb unzip wget

# Download IB Gateway (stable)
// turbo
cd /opt && wget -q https://download2.interactivebrokers.com/installers/ibgateway/stable-standalone/ibgateway-stable-standalone-linux-x64.sh

# Make executable and install
// turbo
chmod +x ibgateway-stable-standalone-linux-x64.sh && yes "" | ./ibgateway-stable-standalone-linux-x64.sh -q

# Create startup script
cat > /opt/start-ibgateway.sh << 'EOF'
#!/bin/bash
export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 &
sleep 2
cd /opt/ibgateway
./ibgateway &
echo "IB Gateway started on display :99"
EOF
chmod +x /opt/start-ibgateway.sh
```

## Step 4: Configure IB Gateway
```bash
# Start IB Gateway (first time — manual config)
/opt/start-ibgateway.sh
```

Then configure via `ibcontroller` or manually:
- Set **API Socket Port**: `4001` (live) or `4002` (paper)
- Enable **"Accept incoming connection"**
- Set **Trusted IPs**: `127.0.0.1`

## Step 5: Install Node.js IBKR Client
```bash
// turbo
cd ~/Command-Centre && npm install @stoqey/ib
```

## Step 6: Create IB Gateway systemd service
```bash
cat > /etc/systemd/system/ibgateway.service << 'EOF'
[Unit]
Description=IB Gateway
After=network.target

[Service]
Type=simple
ExecStart=/opt/start-ibgateway.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl enable ibgateway
systemctl start ibgateway
```

## Step 7: Test Connection
```bash
cd ~/Command-Centre && node -e "
const { IBApi, EventName } = require('@stoqey/ib');
const ib = new IBApi({ port: 4002 }); // 4002 for paper
ib.on(EventName.connected, () => console.log('✅ Connected to IBKR!'));
ib.on(EventName.error, (err) => console.log('❌ Error:', err.message));
ib.connect();
setTimeout(() => { ib.disconnect(); process.exit(); }, 5000);
"
```

## Step 8: Add credentials to .env
```bash
echo 'IBKR_PORT=4002' >> ~/Command-Centre/.env
echo 'IBKR_ENABLED=true' >> ~/Command-Centre/.env
```

## Troubleshooting
- **"Cannot connect"**: Make sure IB Gateway is running (`ps aux | grep ibgateway`)
- **"API not enabled"**: Check Account Management → API Settings on ibkr.com
- **Delayed data**: Subscribe to market data bundle ($10/mo)
- **TWS auto-logout**: IB Gateway stays connected longer than TWS. Set auto-restart in systemd.
