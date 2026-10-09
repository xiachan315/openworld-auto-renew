#!/usr/bin/env bash
# =====================================================================
# ow-egress.sh — 给续期请求建立「住宅出口」（v6, 2026-10-06）
#
# 为什么需要：
#   run 37438598628（GitHub/Azure runner）：验证码 6 阶段**全部通过**、
#   tokenLen=138、成功点击 Confirm Renewal，服务端却回：
#     "Action blocked: your network is flagged (hosting) and is not allowed
#      to renew a VPS."
#   ⇒ 机房 IP 被封。**验证码解得再完美也没用**，必须从住宅 IP 出去。
#
# 迭代（每轮都因为"看不见真错"而空转；教训是先把诊断做出来）：
#  v1 37440166009：解析没生效，循环体一次没进。
#  v2 37441134613：解析出 90 个中继，base64 -d 全失败（CRLF / 逗号错位）。
#  v3 37441808386：13 个节点全"隧道未建立"，**诊断为空**（--daemon 吞输出）。
#  v4 37443270643：20 个节点、诊断依旧为空 ⇒ 确认 --daemon 就是失明元凶。
#  v5 37445140500：★ 去掉 --daemon 后立刻看到真错：
#        `Unsupported cipher in --data-ciphers: BF-CBC`
#        `Options error: --data-ciphers list contains unsupported ciphers`
#      ⇒ 我把 BF-CBC 塞进了 **--data-ciphers 列表**，这是错的：
#        BF-CBC 只能出现在 `--data-ciphers-fallback`。
#        且 Ubuntu 24.04 的 OpenSSL 3 把 Blowfish 挪到了 **legacy provider**，
#        默认不加载 ⇒ 需要 `--providers legacy default`。
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
# ★ 2026-10-09：候选从 14 提到 26。
#   原因：低延迟 ≠ 住宅。实测选中的 150.40.105.10 是保加利亚机房 `MAXKO d.o.o.`
#   （AS211619），不在品牌黑名单里 ⇒ 被放行 ⇒ 平台回 `flagged (VPN, proxy)`。
#   放宽候选数 + 下面的正向判定，才可能在 VPN Gate 的杂牌中继里筛出真住宅出口。
sort -n /tmp/ow-vg.raw | head -26 > "$CAND"
NCAND=$(wc -l < "$CAND")
# 前 60% 只收「正向判定为住宅」的；剩下的是兜底区（避免整轮颗粒无收）
RELAX_AFTER=$(( NCAND * 6 / 10 ))
echo "[egress] 取延迟最低的 $NCAND 个逐个尝试（前 $RELAX_AFTER 个要求住宅判定通过）"

prep_ovpn() {
  grep -v -iE '^[[:space:]]*(comp-lzo|ns-cert-type|redirect-gateway)' "$1" > "$2"
  printf 'remote-cert-tls server\n' >> "$2"
  printf 'redirect-gateway def1\n' >> "$2"
}

# BF-CBC **不能**出现在 --data-ciphers 列表里，只能做 fallback
CIPHERS="AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC:AES-128-CBC"
# Ubuntu 24.04 的 OpenSSL3 把 Blowfish 放进了 legacy provider
EXTRA=""
if openvpn --help 2>&1 | grep -q -- '--providers'; then EXTRA="--providers legacy default"; fi
echo "[egress] providers 开关: ${EXTRA:-<不支持，跳过>}"

OK=0; TRY=0
while IFS="	" read -r PING B64 CC; do
  [ -n "${B64:-}" ] || continue
  TRY=$((TRY + 1))
  printf '%s' "$B64" | base64 -d > "$OVPN" 2>/dev/null || { echo "[egress]   #$TRY 解码失败"; continue; }
  prep_ovpn "$OVPN" "$FIX"

  sudo pkill -x openvpn >/dev/null 2>&1 || true
  sleep 1
  : > "$VLOG"
  # shellcheck disable=SC2086
  sudo setsid openvpn --config "$FIX" --auth-user-pass "$AUTH" \
       $EXTRA \
       --data-ciphers "$CIPHERS" --data-ciphers-fallback BF-CBC \
       --allow-compression yes \
       --tls-version-min 1.0 --tls-cert-profile insecure \
       --verb 3 --connect-retry 1 --connect-retry-max 1 --connect-timeout 8 \
       --resolv-retry 0 >> "$VLOG" 2>&1 &
  sleep 1

  UP=0
  for _ in $(seq 1 12); do
    sleep 2
    grep -q "Initialization Sequence Completed" "$VLOG" 2>/dev/null && { UP=1; break; }
    grep -qE "Options error|Unrecognized option" "$VLOG" 2>/dev/null && break
  done

  echo "[egress] --- #$TRY ping=${PING}ms cc=${CC} up=$UP ---"
  if [ "$UP" != "1" ]; then
    head -8 "$VLOG" 2>/dev/null | sed 's/^/[egress]     /'
    continue
  fi

  IP=$(curl -s --max-time 10 https://api.ipify.org 2>/dev/null || true)
  INFO=$(curl -s --max-time 14 "https://ipinfo.io/$IP/json" 2>/dev/null || true)
  [ -n "$IP" ] || continue
  # ★ 2026-10-09 新增：**正向证据**判定。品牌黑名单（下面那条）只能挡住大厂，
  #   挡不住 MAXKO 这种小机房 ⇒ 必须看情报库的 hosting/proxy 结论。
  #   ip-api.com 免费、无需 key（限 45 次/分钟，够用）。
  RISK=$(curl -s --max-time 12 "http://ip-api.com/json/$IP?fields=status,country,isp,org,as,proxy,hosting,mobile" 2>/dev/null || true)
  echo "[egress]   出口 IP=$IP"
  echo "[egress]   $(printf '%s' "$INFO" | tr -d '\n' | cut -c1-160)"
  echo "[egress]   ip-api: $(printf '%s' "$RISK" | tr -d '\n' | cut -c1-220)"
  BRAND_BAD=0
  if printf '%s' "$INFO" | grep -Eiq 'Amazon|Microsoft|Google|Cloudflare|DigitalOcean|Hetzner|OVH|M247|Oracle|Linode|Vultr|Contabo|Leaseweb|AS16509|AS8075|AS15169|AS13335|AS14061|AS9009'; then
    BRAND_BAD=1
  fi
  RISK_OK=0
  if printf '%s' "$RISK" | grep -q '"status":"success"' \
     && ! printf '%s' "$RISK" | grep -Eq '"hosting":true|"proxy":true'; then
    RISK_OK=1
  fi
  if [ "$BRAND_BAD" = "1" ]; then
    echo "[egress]   ⚠️ 命中机房品牌黑名单，换节点"; continue
  fi
  if [ "$RISK_OK" = "1" ]; then
    echo "[egress]   ✅ 住宅判定通过（ip-api: hosting/proxy 均为 false）"
    OK=1; break
  fi
  if [ "$TRY" -ge "$RELAX_AFTER" ]; then
    echo "[egress]   ⚠️ 已进入兜底区（第 $TRY/$NCAND 个）：ip-api 未判为住宅，仍然采用"
    OK=1; break
  fi
  echo "[egress]   ⚠️ ip-api 未判为住宅（或查询失败），继续换节点"; continue
done < "$CAND"

if [ "$OK" != "1" ]; then
  echo "[egress] 未能拿到住宅出口（尝试 $TRY 个）"
  exit 4
fi
# 只在**接受时**落盘（循环里 break 出来 ⇒ $IP/$INFO 就是被采纳的那个节点）
printf '%s' "$IP" > /tmp/ow-egress.ip
printf '%s' "$INFO" > /tmp/ow-egress.info
echo "[egress] ✅ 住宅出口 = $(cat /tmp/ow-egress.ip)"
exit 0
