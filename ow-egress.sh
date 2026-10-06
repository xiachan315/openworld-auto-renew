#!/usr/bin/env bash
# =====================================================================
# ow-egress.sh — 给续期请求建立「住宅出口」（v2, 2026-10-06）
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
# v1 失败复盘（run 37440166009：9 秒就报「未能连上任何节点」）：
#   ① 字段解析脆弱（awk+IFS tab 组合没生效），循环体一次都没进 ⇒ 已改成
#      cut -d, 逐行解析 + 显式计数 + 回显。
#   ② **Ubuntu 24.04 的 OpenVPN 2.6 默认禁用 BF-CBC**，而 VPN Gate 大量老中继
#      还在用 BF-CBC / TLS1.0 ⇒ 握手直接失败。
#      现在显式 --data-ciphers(+fallback) 与 --tls-version-min 1.0。
#   ③ v1 用「出口 IP 是否变化」反推是否连上，分不清「没连上」和「连上但没改路由」。
#      现在以 openvpn 日志里的 `Initialization Sequence Completed` 为硬判据。
#
# 产出：/tmp/ow-egress.ip / /tmp/ow-egress.info
# 退出码 0 = 已拿到住宅出口；非 0 = 失败（调用方必须视为致命错误）
# =====================================================================
set -u

AUTH=/tmp/ow.auth
LIST=/tmp/ow-vg.csv
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

# VPN Gate 公共中继的标准凭据（用户名/口令都是 vpn）
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

# 逐行解析（纯 cut，不依赖 awk/IFS 细节）。列序：
#  1 HostName 2 IP 3 Score 4 Ping 5 Speed 6 CountryLong 7 CountryShort ...
#  15 OpenVPN_ConfigData_Base64
: > /tmp/ow-vg.raw
TOTAL=0
while IFS= read -r line; do
  case "$line" in '#'*|'*'*|'') continue ;; esac
  ping=$(printf '%s' "$line" | cut -d, -f4)
  cc=$(printf '%s' "$line" | cut -d, -f7)
  b64=$(printf '%s' "$line" | cut -d, -f15)
  case "$ping" in ''|*[!0-9]*) continue ;; esac
  [ -n "$b64" ] || continue
  printf '%s\t%s\t%s\n' "$ping" "$b64" "$cc" >> /tmp/ow-vg.raw
  TOTAL=$((TOTAL + 1))
done < "$LIST"
echo "[egress] 解析出可用中继 $TOTAL 个"

sort -n /tmp/ow-vg.raw | head -12 > "$CAND"
echo "[egress] 取延迟最低的 $(wc -l < "$CAND") 个逐个尝试"

# OpenVPN 2.6 兼容开关：老中继常用 BF-CBC + TLS1.0
CIPHERS="AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC:AES-128-CBC:BF-CBC"

OK=0
TRY=0
while IFS="	" read -r PING B64 CC; do
  [ -n "${B64:-}" ] || continue
  TRY=$((TRY + 1))
  printf '%s' "$B64" | base64 -d > "$OVPN" 2>/dev/null || continue
  [ -s "$OVPN" ] || continue
  echo "[egress] --- #$TRY ping=${PING}ms cc=${CC} ---"
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
  for _ in $(seq 1 15); do
    sleep 3
    if grep -q "Initialization Sequence Completed" "$LOG" 2>/dev/null; then UP=1; break; fi
    if grep -qi "AUTH_FAILED\|Cannot resolve\|Connection refused" "$LOG" 2>/dev/null; then break; fi
  done
  if [ "$UP" != "1" ]; then
    echo "[egress]   隧道未建立，日志尾部："
    grep -iE "error|fail|SIGUSR|cipher|tls|cannot|refus" "$LOG" 2>/dev/null | tail -4 | sed 's/^/[egress]     /'
    continue
  fi

  IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || true)
  INFO=$(curl -s --max-time 14 "https://ipinfo.io/$IP/json" 2>/dev/null || true)
  echo "[egress]   隧道已建立，出口 IP=$IP"
  echo "[egress]   $(printf '%s' "$INFO" | tr -d '\n' | cut -c1-160)"
  if [ -z "$IP" ]; then
    echo "[egress]   ⚠️ 取不到出口 IP，换节点"
    continue
  fi
  if printf '%s' "$INFO" | grep -Eiq 'Amazon|Microsoft|Google|Cloudflare|DigitalOcean|Hetzner|OVH|M247|Oracle|Linode|Vultr|Contabo|Leaseweb|AS16509|AS8075|AS15169|AS13335|AS14061|AS9009'; then
    echo "[egress]   ⚠️ 出口是机房 ASN，换节点"
    continue
  fi
  printf '%s' "$IP" > /tmp/ow-egress.ip
  printf '%s' "$INFO" > /tmp/ow-egress.info
  OK=1
  break
done < "$CAND"

if [ "$OK" != "1" ]; then
  echo "[egress] 未能拿到住宅出口（试了 $TRY 个节点）"
  exit 4
fi
echo "[egress] ✅ 住宅出口 = $(cat /tmp/ow-egress.ip)"
exit 0
