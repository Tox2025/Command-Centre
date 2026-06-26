#!/bin/bash
# Daily backup script for Command Centre trading data
# Runs at 4:30 PM ET (after market close) via cron
# Keeps 30 days of rolling backups

BACKUP_DIR="/root/Command-Centre/data/backups/daily"
DATA_DIR="/root/Command-Centre/data"
DATE=$(date +%Y%m%d)
MAX_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

echo "[Backup] Starting daily backup for $DATE"

# Backup critical files
for FILE in trade-journal.json options-paper-trades.json ml-model-daytrade.json ml-model-swing.json ml-training-cumulative.json; do
    if [ -f "$DATA_DIR/$FILE" ]; then
        cp "$DATA_DIR/$FILE" "$BACKUP_DIR/${FILE%.json}-${DATE}.json"
        echo "[Backup] ✅ $FILE"
    fi
done

# Backup version models
for FILE in $DATA_DIR/ml-model-dayTrade-v*.json; do
    if [ -f "$FILE" ]; then
        BASENAME=$(basename "$FILE" .json)
        cp "$FILE" "$BACKUP_DIR/${BASENAME}-${DATE}.json"
    fi
done

echo "[Backup] ✅ Version models"

# Clean old backups (older than MAX_DAYS)
find "$BACKUP_DIR" -name "*.json" -mtime +$MAX_DAYS -delete
DELETED=$(find "$BACKUP_DIR" -name "*.json" -mtime +$MAX_DAYS 2>/dev/null | wc -l)
echo "[Backup] 🗑️ Cleaned $DELETED old backups (>$MAX_DAYS days)"

# Count total backups
TOTAL=$(ls -1 "$BACKUP_DIR"/*.json 2>/dev/null | wc -l)
echo "[Backup] 📦 Total backup files: $TOTAL"
echo "[Backup] Complete for $DATE"
