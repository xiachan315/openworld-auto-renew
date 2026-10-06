#!/usr/bin/env bash
# =====================================================================
# ow-egress.sh — 给续期请求建立「住宅出口」
#
# 为什么需要：
#   实测 run 37438598628：GitHub(Azure) runner 上验证码 6 个阶段**全部通过**、
#   拿到 138 字符 token、成功点了 Confirm Renewal，但服务端回：
#     "Action blocked: your network is flagged (hosting) and is not allowed
#      to renew a VPS."
#   ⇒ 机房 IP 被封。**再完美的验证码求解也没用**，必须让请求从住宅 IP 出去。
#
# 做法：VPN Gate（vpngate.net）是全球志愿者用**自家宽带**开的公共中继，
#   出口 ASN 是消费级 ISP。按 Ping 升序挑若干节点逐个试，连上后用 ipinfo
#   校验出口 ASN，确认不是机房才放行。
#
# 产出：/tmp/ow-egress.ip   出口 IP
#      /tmp/ow-egress.info 出口 ipinfo JSON
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
command -v openvpn >/dev/null 2>&1 || { echo "[egress] openvpn 安装失败"; exit 2; }

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

# 数据行按 Ping（第 4 列）升序；第 15 列是 base64 的 .ovpn，第 7 列是国家码
awk -F, 'NF>14 {print $4"\t"$15"\t"$7}' "$LIST" | grep -v '^[^0-9]' | sort -n | head -16 > "$CAND"
echo "[egress] 候选节点 $(wc -l < "$CAND") 个"

OK=0
while IFS="$(printf '\t')" read -r PING B64 CC; do
  [ -n "${B64:-}" ] || continue
  echo "$B64" | base64 -d > "$OVPN" 2>/dev/null || continue
  [ -s "$OVPN" ] || continue
  echo "[egress] --- 尝试 ping=${PING}ms cc=${CC} ---"
  sudo pkill -x openvpn >/dev/null 2>&1 || true
  sleep 2
  sudo openvpn --config "$OVPN" --auth-user-pass "$AUTH" \
       --daemon --log "$LOG" \
       --connect-retry 1 --connect-retry-max 1 --connect-timeout 15 \
       --resolv-retry 0 >/dev/null 2>&1 || true
  for _ in $(seq 1 12); do
    sleep 5
    IP=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || true)
    [ -n "$IP" ] || continue
    INFO=$(curl -s --max-time 12 "https://ipinfo.io/$IP/json" 2>/dev/null || true)
    echo "[egress]   出口 IP=$IP org=$(echo "$INFO" | tr -d '\n' | cut -c1-150)"
    if echo "$INFO" | grep -Eiq 'Amazon|Microsoft|Google|Cloudflare|DigitalOcean|Hetzner|OVH|M247|Oracle|Linode|Vultr|Contabo|Leaseweb|AS16509|AS8075|AS15169|AS13335|AS14061'; then
      echo "[egress]   ⚠️ 仍是机房 ASN，换下一个节点"
      break
    fi
    printf '%s' "$IP" > /tmp/ow-egress.ip
    printf '%s' "$INFO" > /tmp/ow-egress.info
    OK=1
    break
  done
  [ "$OK" = "1" ] && break
done < "$CAND"

if [ "$OK" != "1" ]; then
  echo "[egress] 未能连上任何 VPN Gate 住宅节点"
  tail -30 "$LOG" 2>/dev/null || true
  exit 4
fi
echo "[egress] ✅ 住宅出口 = $(cat /tmp/ow-egress.ip)"
exit 0
