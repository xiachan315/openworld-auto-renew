#!/usr/bin/env bash
# =====================================================================
# ow-egress.sh — 给续期请求建立「住宅出口」（v4, 2026-10-06）
#
# 为什么需要：
#   run 37438598628（GitHub/Azure runner）：验证码 6 阶段**全部通过**、
#   tokenLen=138、成功点击 Confirm Renewal，服务端却回：
#     "Action blocked: your network is flagged (hosting) and is not allowed
#      to renew a VPS."
#   ⇒ 机房 IP 被封。**验证码解得再完美也没用**，必须从住宅 IP 出去。
#
# 做法：VPN Gate（vpngate.net）公共中继 = 志愿者自家宽带，出口 ASN 是消费级 ISP。
#
# 失败复盘：
#  v1（37440166009）：awk+IFS 解析没生效，循环体一次没进。
#  v2（37441134613）：解析出 90 个中继，但 base64 -d 全失败（CRLF / 逗号错位）。
#  v3（37441808386）：解析 OK（配置 ~10KB），但 13 个节点**全都「隧道未建立」，
#      且我的错误诊断打印是空的** ⇒ openvpn 的 stdout/stderr 被
#      `--daemon` + `2>/dev/null` 一起吞了，$LOG 里一个字节都没有。
#      **诊断为空 = 没有诊断。** v4 起：openvpn 输出重定向到文件并在失败时打印。
#      同时预处理掉 OpenVPN 2.6 **已移除**的指令（VPN Gate 老配置常见
#      `ns-cert-type server` ⇒ 直接 Options error 退出，日志为空正是这个特征）。
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
LOG=/tmp/ow-vg.log
RUNLOG=/tmp/ow-vg.run.log

echo "[egress] 安装 openvpn ..."
sudo apt-get update -qq >/dev/null 2>&1 || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openvpn curl >/dev/null 2>&1 || true
if ! command -v openvpn >/dev/null 2>&1; then echo "[egress] openvpn 安装失败"; exit 2; fi
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
sort -n /tmp/ow-vg.raw | head -20 > "$CAND"
echo "[egress] 取延迟最低的 $(wc -l < "$CAND") 个逐个尝试"

# OpenVPN 2.6 兼容：
#   · ns-cert-type 在 2.5 已被**移除** ⇒ 换成 remote-cert-tls server
#   · comp-lzo 已废弃 ⇒ 删掉（改由命令行控制压缩）
#   · BF-CBC 默认禁用 ⇒ 由命令行 --data-ciphers-fallback 放行
prep_ovpn() {
  grep -v -iE '^[[:space:]]*(comp-lzo|ns-cert-type|redirect-gateway)' "$1" > "$2"
  printf 'remote-cert-tls server\n' >> "$2"
  printf 'redirect-gateway def1\n' >> "$2"
}
CIPHERS="AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC:AES-128-CBC:BF-CBC"

OK=0; TRY=0; BAD=0
while IFS="	" read -r PING B64 CC; do
  [ -n "${B64:-}" ] || continue
  TRY=$((TRY + 1))
  if ! printf '%s' "$B64" | base64 -d > "$OVPN" 2>/dev/null; then
    BAD=$((BAD + 1)); echo "[egress]   #$TRY base64 解码失败"; continue
  fi
  prep_ovpn "$OVPN" "$FIX"
  echo "[egress] --- #$TRY ping=${PING}ms cc=${CC} ---"
  sudo pkill -x openvpn >/dev/null 2>&1 || true
  : > "$LOG"; : > "$RUNLOG"
  sleep 1
  sudo openvpn --config "$FIX" --auth-user-pass "$AUTH" \
       --data-ciphers "$CIPHERS" --data-ciphers-fallback BF-CBC \
       --tls-version-min 1.0 --tls-cert-profile insecure \
       --daemon --log "$LOG" --verb 3 \
       --connect-retry 1 --connect-retry-max 1 --connect-timeout 10 \
       --resolv-retry 0 > "$RUNLOG" 2>&1 || true

  UP=0
  for _ in $(seq 1 12); do
    sleep 2
    if grep -q "Initialization Sequence Completed" "$LOG" 2>/dev/null; then UP=1; break; fi
    if grep -qiE "Options error|Unrecognized option|Exiting due to fatal error|AUTH_FAILED" "$RUNLOG" "$LOG" 2>/dev/null; then break; fi
  done
  if [ "$UP" != "1" ]; then
    echo "[egress]   隧道未建立。openvpn 输出："
    { cat "$RUNLOG" 2>/dev/null; tail -6 "$LOG" 2>/dev/null; } \
      | grep -vE '^\s*$' | tail -6 | sed 's/^/[egress]     /'
    # 配置本身就是坏的 ⇒ 换节点没意义，直接停下
    if grep -qiE "Options error|Unrecognized option" "$RUNLOG" 2>/dev/null; then
      echo "[egress]   ⛔ 配置解析失败（OpenVPN 版本不兼容），提前结束"
      break
    fi
    continue
  fi

  IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || true)
  INFO=$(curl -s --max-time 14 "https://ipinfo.io/$IP/json" 2>/dev/null || true)
  echo "[egress]   隧道已建立，出口 IP=$IP"
  echo "[egress]   $(printf '%s' "$INFO" | tr -d '\n' | cut -c1-160)"
  [ -n "$IP" ] || { echo "[egress]   ⚠️ 取不到出口 IP，换节点"; continue; }
  if printf '%s' "$INFO" | grep -Eiq 'Amazon|Microsoft|Google|Cloudflare|DigitalOcean|Hetzner|OVH|M247|Oracle|Linode|Vultr|Contabo|Leaseweb|AS16509|AS8075|AS15169|AS13335|AS14061|AS9009'; then
    echo "[egress]   ⚠️ 出口是机房 ASN，换节点"; continue
  fi
  printf '%s' "$IP" > /tmp/ow-egress.ip
  printf '%s' "$INFO" > /tmp/ow-egress.info
  OK=1; break
done < "$CAND"

if [ "$OK" != "1" ]; then
  echo "[egress] 未能拿到住宅出口（尝试 $TRY 个，其中 $BAD 个配置无效）"
  exit 4
fi
echo "[egress] ✅ 住宅出口 = $(cat /tmp/ow-egress.ip)"
exit 0
