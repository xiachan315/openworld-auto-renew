#!/usr/bin/env bash
# =====================================================================
# ow-egress.sh — 给续期请求建立「住宅出口」（v3, 2026-10-06）
#
# 为什么需要：
#   实测 run 37438598628（GitHub/Azure runner）：验证码 6 个阶段**全部通过**、
#   tokenLen=138、成功点击 Confirm Renewal，但服务端回：
#     "Action blocked: your network is flagged (hosting) and is not allowed
#      to renew a VPS."
#   ⇒ 机房 IP 被封。**验证码解得再完美也没用**，必须让请求从住宅 IP 出去。
#
# 做法：VPN Gate（vpngate.net）公共中继 = 志愿者自家宽带，出口 ASN 是消费级 ISP。
#
# 失败复盘：
#  v1（run 37440166009）：awk+IFS 解析没生效，循环体一次没进。
#  v2（run 37441134613）：解析出 90 个中继，但 12 个节点**全部 continue 掉、
#      从未真正发起连接** ⇒ 根因是 `base64 -d` 失败。两个可能：
#        · CSV 是 CRLF ⇒ 末字段带 '\r' ⇒ base64 报 invalid input
#        · `Message` 列里含逗号 ⇒ `cut -f15` 取错列
#      对策：先 `tr -d '\r'`；base64 取**最后一个逗号之后的全部内容**
#      （base64 字母表不含逗号，所以「最后一个逗号后」恒等于该列），
#      并对解码失败做显式诊断而不是静默 continue。
#
# 产出：/tmp/ow-egress.ip / /tmp/ow-egress.info
# 退出码 0 = 已拿到住宅出口；非 0 = 失败（调用方必须视为致命错误）
# =====================================================================
set -u

AUTH=/tmp/ow.auth
LIST=/tmp/ow-vg.csv
CLEAN=/tmp/ow-vg.clean
CAND=/tmp/ow-vg.cand
OVPN=/tmp/ow-vg.ovpn
LOG=/tmp/ow-vg.log

echo "[egress] 安装 openvpn ..."
sudo apt-get update -qq >/dev/null 2>&1 || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openvpn curl >/dev/null 2>&1 || true
if ! command -v openvpn >/dev/null 2>&1; then echo "[egress] openvpn 安装失败"; exit 2; fi
openvpn --version 2>/dev/null | head -1

# 关掉 IPv6：避免浏览器走 AAAA 直连（那样出口就不是隧道了）
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
printf 'vpn\nvpn\n' > "$AUTH"

fetch_list() {
  for u in "https://www.vpngate.net/api/iphone/" \
           "https://vpngate.net/api/iphone/" \
           "http://www.vpngate.net/api/iphone/"; do
    if curl -s --max-time 45 -A "Mozilla/5.0" "$u" -o "$LIST" 2>/dev/null; then
      if [ "$(wc -c < "$LIST" 2>/dev/null || echo 0)" -gt 5000 ]; then
        echo "[egress] 节点列表来自 $u（$(wc -c < "$LIST") 字节）"
        return 0
      fi
    fi
    echo "[egress] 列表源不可用: $u"
  done
  return 1
}
fetch_list || { echo "[egress] 拿不到 VPN Gate 列表"; exit 3; }

# CRLF ⇒ LF；否则末字段会带 '\r' 让 base64 -d 报 invalid input
tr -d '\r' < "$LIST" > "$CLEAN"

: > /tmp/ow-vg.raw
TOTAL=0
SHOWN=0
while IFS= read -r line; do
  case "$line" in '#'*|'*'*|'') continue ;; esac
  ping=$(printf '%s' "$line" | cut -d, -f4)
  cc=$(printf '%s' "$line" | cut -d, -f7)
  # base64 取「最后一个逗号之后」——Message 列含逗号也不会错位
  b64=$(printf '%s' "$line" | rev | cut -d, -f1 | rev)
  if [ "$SHOWN" = "0" ]; then
    NF=$(printf '%s' "$line" | awk -F, '{print NF}')
    echo "[egress] 样本: 字段数=$NF ping='$ping' cc='$cc' b64长度=${#b64}"
    SHOWN=1
  fi
  case "$ping" in ''|*[!0-9]*) continue ;; esac
  [ -n "$b64" ] || continue
  printf '%s\t%s\t%s\n' "$ping" "$b64" "$cc" >> /tmp/ow-vg.raw
  TOTAL=$((TOTAL + 1))
done < "$CLEAN"
echo "[egress] 解析出可用中继 $TOTAL 个"

sort -n /tmp/ow-vg.raw | head -20 > "$CAND"
echo "[egress] 取延迟最低的 $(wc -l < "$CAND") 个逐个尝试"

# OpenVPN 2.6 兼容开关：老中继常用 BF-CBC + TLS1.0
CIPHERS="AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC:AES-128-CBC:BF-CBC"

OK=0
TRY=0
BAD=0
while IFS="	" read -r PING B64 CC; do
  [ -n "${B64:-}" ] || continue
  TRY=$((TRY + 1))
  if ! printf '%s' "$B64" | base64 -d > "$OVPN" 2>/dev/null; then
    BAD=$((BAD + 1)); echo "[egress]   #$TRY base64 解码失败（长度 ${#B64}）"; continue
  fi
  if ! grep -qE '^[[:space:]]*(remote|proto|dev)[[:space:]]' "$OVPN"; then
    BAD=$((BAD + 1)); echo "[egress]   #$TRY 解出来不是 ovpn（$(head -c 40 "$OVPN" | tr -d '\n')）"; continue
  fi
  echo "[egress] --- #$TRY ping=${PING}ms cc=${CC} ($(wc -c < "$OVPN") 字节配置) ---"
  sudo pkill -x openvpn >/dev/null 2>&1 || true
  : > "$LOG"
  sleep 1
  sudo openvpn --config "$OVPN" --auth-user-pass "$AUTH" \
       --data-ciphers "$CIPHERS" --data-ciphers-fallback BF-CBC \
       --tls-version-min 1.0 --tls-cert-profile insecure \
       --redirect-gateway def1 \
       --daemon --log "$LOG" --verb 3 \
       --connect-retry 1 --connect-retry-max 1 --connect-timeout 12 \
       --resolv-retry 0 >/dev/null 2>&1 || true

  UP=0
  for _ in $(seq 1 12); do
    sleep 3
    if grep -q "Initialization Sequence Completed" "$LOG" 2>/dev/null; then UP=1; break; fi
    if grep -qi "AUTH_FAILED\|Cannot resolve\|Connection refused" "$LOG" 2>/dev/null; then break; fi
  done
  if [ "$UP" != "1" ]; then
    echo "[egress]   隧道未建立：$(grep -iE 'error|fail|SIGUSR|cipher|tls|cannot|refus|timeout' "$LOG" 2>/dev/null | tail -2 | tr '\n' ' ' | cut -c1-180)"
    continue
  fi

  IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || true)
  INFO=$(curl -s --max-time 14 "https://ipinfo.io/$IP/json" 2>/dev/null || true)
  echo "[egress]   隧道已建立，出口 IP=$IP"
  echo "[egress]   $(printf '%s' "$INFO" | tr -d '\n' | cut -c1-160)"
  if [ -z "$IP" ]; then echo "[egress]   ⚠️ 取不到出口 IP，换节点"; continue; fi
  if printf '%s' "$INFO" | grep -Eiq 'Amazon|Microsoft|Google|Cloudflare|DigitalOcean|Hetzner|OVH|M247|Oracle|Linode|Vultr|Contabo|Leaseweb|AS16509|AS8075|AS15169|AS13335|AS14061|AS9009'; then
    echo "[egress]   ⚠️ 出口是机房 ASN，换节点"; continue
  fi
  printf '%s' "$IP" > /tmp/ow-egress.ip
  printf '%s' "$INFO" > /tmp/ow-egress.info
  OK=1
  break
done < "$CAND"

if [ "$OK" != "1" ]; then
  echo "[egress] 未能拿到住宅出口（尝试 $TRY 个，其中 $BAD 个配置无效）"
  exit 4
fi
echo "[egress] ✅ 住宅出口 = $(cat /tmp/ow-egress.ip)"
exit 0
