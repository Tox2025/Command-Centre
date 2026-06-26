#!/bin/bash
# Full system setup script for Command Centre
# Deploys: systemd services, daily backups, training data cleanup
# Run on Server-2 after git pull

echo "=== Command Centre System Setup ==="
echo ""

# 1. Pull latest code
echo "--- Step 1: Pull latest code ---"
cd ~/Command-Centre && git pull origin main

# 2. Set up systemd service for IBC Gateway (if not already running)
echo ""
echo "--- Step 2: Check IBC systemd service ---"
if systemctl is-active --quiet ibc 2>/dev/null; then
    echo "✅ IBC service already running"
else
    echo "⚠️ IBC service not running. To set up, run: bash ~/Command-Centre/fix-ibkr.sh"
    echo "   (Only if Gateway is not already running manually)"
fi

# 3. Set up daily backup cron
echo ""
echo "--- Step 3: Set up daily backup cron ---"
chmod +x ~/Command-Centre/scripts/daily-backup.sh
# Check if cron already exists
if crontab -l 2>/dev/null | grep -q "daily-backup.sh"; then
    echo "✅ Daily backup cron already exists"
else
    # Add cron: 4:30 PM ET = 20:30 UTC (or 22:30 UTC in summer)
    (crontab -l 2>/dev/null; echo "30 20 * * 1-5 /root/Command-Centre/scripts/daily-backup.sh >> /var/log/trading-backup.log 2>&1") | crontab -
    echo "✅ Daily backup cron added (4:30 PM ET, Mon-Fri)"
fi

# 4. Run initial backup now
echo ""
echo "--- Step 4: Run initial backup ---"
bash ~/Command-Centre/scripts/daily-backup.sh

# 5. Clean garbage training data
echo ""
echo "--- Step 5: Clean garbage training data ---"
node ~/Command-Centre/scripts/clean-training-data.js

# 6. Restart trading bot
echo ""
echo "--- Step 6: Restart trading bot ---"
pm2 restart trading-bot --update-env
sleep 10

# 7. Verify
echo ""
echo "--- Step 7: Verify ---"
echo "Memory:"
free -h
echo ""
echo "Swap:"
swapon --show
echo ""
echo "PM2:"
pm2 list
echo ""
echo "Gateway:"
ss -tlnp | grep java && echo "✅ Gateway on port 4002" || echo "❌ Gateway not running"
echo ""
echo "ML Models:"
grep -i "MLCalibrator" /root/.pm2/logs/trading-bot-out.log | tail -3
echo ""
echo "IBKR:"
grep -i "Broker connected" /root/.pm2/logs/trading-bot-out.log | tail -1
echo ""
echo "=== Setup Complete ==="
