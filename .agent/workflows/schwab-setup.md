---
description: How to set up Schwab Trader API for paper and live trading
---

# Schwab Trader API Setup

## Step 1: Create a Developer Account
1. Go to the [Schwab Developer Portal](https://developer.schwab.com/)
2. Register for an account and wait for approval (usually 24-48 hours).

## Step 2: Create an App
1. Log in to the Developer Portal.
2. Go to **Dashboard** -> **Create New App**.
3. Set **App Name**: `CommandCentre-Trading`
4. Set **Callback URL**: `https://127.0.0.1` (or your VPS IP if you have a listener).
5. Select the products: **Accounts and Trading** and **Market Data**.
6. Note your **App Key** and **App Secret**.

## Step 3: Initial Authorization (OAuth)
Schwab uses OAuth2. To get your initial refresh token:
1. Construct the authorization URL with your App Key.
2. Log in with your Schwab credentials (you can use your PaperMoney login here if specifically authorized, but usually, it's the live login).
3. The redirect will contain a `code` parameter.
4. Exchange that code for an `access_token` and `refresh_token`.

## Step 4: Configure VPS Environment
Add these to your `~/Command-Centre/.env`:
```bash
SCHWAB_APP_KEY=your_app_key
SCHWAB_APP_SECRET=your_app_secret
SCHWAB_REFRESH_TOKEN=your_refresh_token
```

## Step 5: Implementation
I will implement a `SchwabClient` in your codebase that handles:
- Token auto-refresh.
- Placing Equity and Option orders.
- Fetching real-time account balances and positions.

## Note on Paper Trading
- Schwab's **PaperMoney** is a separate environment.
- To use the API for PaperMoney, you must check in the Developer Portal if your App is enabled for "Virtual Trading" or use a specific sub-account.
- **Safest Approach**: Connect the API to your PaperMoney credentials first to verify all logic before switching to live.
