#!/usr/bin/env bash
# =====================================================================
# ow-egress.sh — 给续期请求建立「住宅出口」（v5, 2026-10-06）
#
# 为什么需要：
#   run 37438598628（GitHub/Azure runner）：验证码 6 阶段**全部通过**、
#   tokenLen=138、成功点击 Confirm Renewal，服务端却回：
#     "Action blocked: your network is flagged (hosting) and is not allowed
#      to renew a VPS."
#   ⇒ 机房 IP 被封。**验证码解得再完美也没用**，必须从住宅 IP 出去。
#
# 失败复盘（每一步都是"诊断缺失"导致的空转）：
#  v1 37440166009：awk+IFS 解析没生效，循环体一次没进。
#  v2 37441134613：解析出 90 个中继，但 base64 -d 全失败（CRLF / 逗号错位）。
#  v3 37441808386：解析 OK，13 个节点全"隧道未建立"，**诊断打印为空**。
#  v4 37443270643：20 个节点全部"隧道未建立"，**诊断打印依旧为空** ——
#      连续两版都拿不到 openvpn 的一个字节输出。
#      ⇒ 结论：`--daemon` 会把输出彻底吞掉（父进程静默退出、子进程另开 fd），
#        再叠加 stderr 重定向就完全失明。
#  **v5 起彻底不用 --daemon**：用 `setsid` 后台跑 + stdout/stderr 直接重定向到文件
#  + 轮询该文件。宁可多花 1~2 秒，也必须永远看得见 openvpn 说了什么。
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
FIX=/tmp/ow-vg.fixed
VLOG=/tmp/ow-vg.log

echo "[egress] 安装 openvpn ..."
sudo apt-get update -qq >/dev/null 2>&1 || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openvpn curl >/dev/null 2>&1 || true
command -v openvpn >/dev/null 2>&1 || { echo "[egress] openvpn 安装失败"; exit 2; }
openvpn --version 2>/dev/null | head -1

sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
printf 'vpn\nvpn\n' > "$AUTH"

fetch_list() {
  for u in "https://www.vpngate.net/api/iphone/" \
           "https://vpngate.net/api/iphone/" \
           "http://www.vpngate.net/api/iphone/"; do
    if curl -s --max-time 45 -A "Mozilla/5.0" "$u" -o "$LIST" 2>/dev/null; then
      if [ "$(wc -c < "$LIST" 2>/dev/null || echo 0)" -gt 5000 ]; then
        echo "[egress] 节点列表来自 $u（$(wc -c < "$LIST") 字节）"; return 0
      fi
    fi
    echo "[egress] 列表源不可用: $u"
  done
  return 1
}
fetch_list || { echo "[egress] 拿不到 VPN Gate 列表"; exit 3; }

tr -d '\r' < "$LIST" > "$CLEAN"
: > /tmp/ow-vg.raw
TOTAL=0
while IFS= read -r line; do
  case "$line" in '#'*|'*'*|'') continue ;; esac
  ping=$(printf '%s' "$line" | cut -d, -f4)
  cc=$(printf '%s' "$line" | cut -d, -f7)
  b64=$(printf '%s' "$line" | rev | cut -d, -f1 | rev)
  case "$ping" in ''|*[!0-9]*) continue ;; esac
  [ -n "$b64" ] || continue
  printf '%s\t%s\t%s\n' "$ping" "$b64" "$cc" >> /tmp/ow-vg.raw
  TOTAL=$((TOTAL + 1))
done < "$CLEAN"
echo "[egress] 解析出可用中继 $TOTAL 个"
sort -n /tmp/ow-vg.raw | head -12 > "$CAND"
echo "[egress] 取延迟最低的 $(wc -l < "$CAND") 个逐个尝试"

# OpenVPN 2.6 兼容：ns-cert-type 已在 2.5 移除；comp-lzo 废弃；redirect-gateway 由我们自加
prep_ovpn() {
  grep -v -iE '^[[:space:]]*(comp-lzo|ns-cert-type|redirect-gateway)' "$1" > "$2"
  printf 'remote-cert-tls server\n' >> "$2"
  printf 'redirect-gateway def1\n' >> "$2"
}
CIPHERS="AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC:AES-128-CBC:BF-CBC"

OK=0; TRY=0
while IFS="	" read -r PING B64 CC; do
  [ -n "${B64:-}" ] || continue
  TRY=$((TRY + 1))
  printf '%s' "$B64" | base64 -d > "$OVPN" 2>/dev/null || { echo "[egress]   #$TRY 解码失败"; continue; }
  prep_ovpn "$OVPN" "$FIX"

  sudo pkill -x openvpn >/dev/null 2>&1 || true
  sleep 1
  : > "$VLOG"
  # ★ 不用 --daemon：setsid 后台 + 输出直落文件，永远看得见
  sudo setsid openvpn --config "$FIX" --auth-user-pass "$AUTH" \
       --data-ciphers "$CIPHERS" --data-ciphers-fallback BF-CBC \
       --tls-version-min 1.0 --tls-cert-profile insecure \
       --verb 3 --connect-retry 1 --connect-retry-max 1 --connect-timeout 8 \
       --resolv-retry 0 >> "$VLOG" 2>&1 &
  sleep 1

  UP=0
  for _ in $(seq 1 12); do
    sleep 2
    grep -q "Initialization Sequence Completed" "$VLOG" 2>/dev/null && { UP=1; break; }
  done

  echo "[egress] --- #$TRY ping=${PING}ms cc=${CC} up=$UP ---"
  if [ "$UP" != "1" ]; then
    head -14 "$VLOG" 2>/dev/null | sed 's/^/[egress]     /'
    continue
  fi

  IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || true)
  INFO=$(curl -s --max-time 14 "https://ipinfo.io/$IP/json" 2>/dev/null || true)
  echo "[egress]   出口 IP=$IP"
  echo "[egress]   $(printf '%s' "$INFO" | tr -d '\n' | cut -c1-160)"
  [ -n "$IP" ] || continue
  if printf '%s' "$INFO" | grep -Eiq 'Amazon|Microsoft|Google|Cloudflare|DigitalOcean|Hetzner|OVH|M247|Oracle|Linode|Vultr|Contabo|Leaseweb|AS16509|AS8075|AS15169|AS13335|AS14061|AS9009'; then
    echo "[egress]   ⚠️ 出口是机房 ASN，换节点"; continue
  fi
  printf '%s' "$IP" > /tmp/ow-egress.ip
  printf '%s' "$INFO" > /tmp/ow-egress.info
  OK=1; break
done < "$CAND"

if [ "$OK" != "1" ]; then
  echo "[egress] 未能拿到住宅出口（尝试 $TRY 个）"
  exit 4
fi
echo "[egress] ✅ 住宅出口 = $(cat /tmp/ow-egress.ip)"
exit 0
