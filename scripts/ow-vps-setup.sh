#!/bin/sh
# Openworld 自动续期 · VPS 侧触发器安装脚本
# 作用：在本机装一个 systemd timer，每 30 分钟向 GitHub dispatch 一次
#       openworld-auto-renew 仓库的 renew.yml（inputs.auto=1）。
# 依赖：/root/own/gh-auth.txt 内含一行 "Authorization: Bearer <PAT>"（本脚本不含任何密钥）
# 闸门：GitHub 侧 workflow 的 gate job 会做「当日随机时刻 + 当日只跑一次」判定，
#       所以这里高频触发是安全的（绝大多数唤醒都是十几秒的空跑）。
set -e
mkdir -p /root/own

cat > /root/own/ow-trigger.sh <<'XEOF'
#!/bin/sh
exec >>/var/log/ow-trigger.log 2>&1
echo "=== $(date -u +%FT%TZ)"
curl -s -o /dev/null -w "http=%{http_code}\n" -X POST \
  -H "$(cat /root/own/gh-auth.txt)" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d '{"ref":"main","inputs":{"auto":"1"}}' \
  "https://api.github.com/repos/xiachan315/openworld-auto-renew/actions/workflows/renew.yml/dispatches"
echo "--- exit=$?"
XEOF
chmod 700 /root/own/ow-trigger.sh

cat > /etc/systemd/system/ow-trigger.service <<'XEOF'
[Unit]
Description=Openworld renew: dispatch GitHub workflow
After=network-online.target

[Service]
Type=oneshot
ExecStart=/root/own/ow-trigger.sh
XEOF

cat > /etc/systemd/system/ow-trigger.timer <<'XEOF'
[Unit]
Description=Openworld renew trigger (every 30 min)

[Timer]
OnCalendar=*-*-* *:11,41:00
Persistent=false
Unit=ow-trigger.service

[Install]
WantedBy=timers.target
XEOF

systemctl daemon-reload
systemctl enable ow-trigger.timer >/dev/null 2>&1 || true
systemctl start --no-block ow-trigger.timer 2>/dev/null || true

echo "SETUP_DONE enabled=$(systemctl is-enabled ow-trigger.timer 2>/dev/null)"

# 立即试射一次，验证「VPS -> GitHub dispatch」这条链路真的通
/root/own/ow-trigger.sh || true
echo "TRIGGER_FIRED"
