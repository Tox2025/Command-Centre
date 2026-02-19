#!/bin/bash
# VPS Setup Script (Run this on the server)

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 and Git
sudo npm install -g pm2
sudo apt install -y git

# Configure Firewall (Allow SSH, HTTP, HTTPS)
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable

console.log("✅ Server setup complete! You can now clone your repo.");
