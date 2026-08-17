#!/bin/bash
# ============================================================================
# Cherry Studio 会话打包器 —— 把一次成功的 agent 运行导出成一个压缩包
#
# 用途：把你这次跑成功的 agent 会话（对话内容 + 工具调用 + 产出文件）打成一个包，
#      发给需要复刻这次演示的同事。
#
# 用法：
#   bash cherry-collect.sh                 # 打包最近更新的那个会话
#   bash cherry-collect.sh "关键词"         # 按会话标题关键词挑
#   bash cherry-collect.sh --list          # 只列出所有会话，不打包
#
# 依赖：只用系统自带的 sqlite3 与 zip，无需安装任何东西。
# 隐私：不导出 API Key / provider 地址 / MCP 环境变量。对话正文会原样导出，
#      涉密内容请自行删改后再发送。
# ============================================================================
set -euo pipefail

SQLITE=$(command -v sqlite3 || echo /usr/bin/sqlite3)
[ -x "$SQLITE" ] || { echo "❌ 找不到 sqlite3"; exit 1; }

# ── 1. 定位 Cherry Studio 数据目录 ─────────────────────────────────────────
CANDIDATES=(
  "$HOME/Library/Application Support/CherryStudio"
  "$HOME/Library/Application Support/CherryStudioEnterprise"
  "$HOME/.config/CherryStudio"
  "$HOME/.config/cherrystudio"
  "${APPDATA:-}/CherryStudio"
)
USERDATA=""
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -f "$c/cherrystudio.sqlite" ] && { USERDATA="$c"; break; }
done
# 企业版把用户数据放在 users/<hash>/ 下
if [ -z "$USERDATA" ]; then
  for c in "${CANDIDATES[@]}"; do
    [ -n "$c" ] || continue
    found=$(find "$c/users" -maxdepth 2 -name cherrystudio.sqlite 2>/dev/null | head -1 || true)
    [ -n "$found" ] && { USERDATA=$(dirname "$found"); break; }
  done
fi
[ -n "$USERDATA" ] || { echo "❌ 没找到 Cherry Studio 数据目录，请把本脚本连同这条报错发给对方"; exit 1; }

DB_FILE="$USERDATA/cherrystudio.sqlite"
DB="file:$DB_FILE?mode=ro"          # 只读打开，App 正在运行也安全
q() { "$SQLITE" "$DB" "$@"; }

echo "📂 数据目录：$USERDATA"

# ── 2. 选会话 ──────────────────────────────────────────────────────────────
if [ "${1:-}" = "--list" ]; then
  echo
  echo "会话列表（新 → 旧）："
  q -header -column "SELECT substr(id,1,8) AS id, substr(name,1,46) AS name,
      datetime(updated_at/1000,'unixepoch','localtime') AS updated,
      (SELECT COUNT(*) FROM agent_session_message WHERE session_id=s.id) AS msgs
    FROM agent_session s ORDER BY updated_at DESC LIMIT 30;"
  echo
  echo "用法：bash $0 \"标题关键词\""
  exit 0
fi

KEYWORD="${1:-}"
if [ -n "$KEYWORD" ]; then
  SID=$(q "SELECT id FROM agent_session WHERE name LIKE '%$(printf '%s' "$KEYWORD" | sed "s/'/''/g")%' ORDER BY updated_at DESC LIMIT 1;")
  [ -n "$SID" ] || { echo "❌ 没有标题含「$KEYWORD」的会话。用 --list 看看有哪些。"; exit 1; }
else
  SID=$(q "SELECT id FROM agent_session ORDER BY updated_at DESC LIMIT 1;")
  [ -n "$SID" ] || { echo "❌ 这个 Cherry Studio 里没有 agent 会话"; exit 1; }
fi

SNAME=$(q "SELECT name FROM agent_session WHERE id='$SID';")
NMSG=$(q "SELECT COUNT(*) FROM agent_session_message WHERE session_id='$SID';")
TOTAL_MS=$(q "SELECT COALESCE(SUM(updated_at-created_at),0) FROM agent_session_message WHERE session_id='$SID' AND role='assistant';")
echo "🎯 会话：$SNAME"
echo "   $NMSG 条消息，累计耗时 $((TOTAL_MS/1000)) 秒"

# ── 3. 准备输出目录 ────────────────────────────────────────────────────────
STAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="${TMPDIR:-/tmp}/cherry-replay-$STAMP"
mkdir -p "$OUTDIR/artifacts"

# ── 4. 导出会话主体（对话 + 工具调用 + 耗时）─────────────────────────────
q "SELECT json_object(
  'schema','cherry-replay-bundle/1',
  'collectedAt', datetime('now'),
  'session', (SELECT json_object('id',id,'name',name,
                'createdAt',created_at,'updatedAt',updated_at) FROM agent_session WHERE id='$SID'),
  'agent', (SELECT json_object('type',a.type,'name',a.name,'model',a.model,
                'planModel',a.plan_model,'smallModel',a.small_model,
                'instructions',a.instructions,'configuration',json(a.configuration))
             FROM agent a JOIN agent_session s ON s.agent_id=a.id WHERE s.id='$SID'),
  'mcpServers', (SELECT json_group_array(json_object('name',m.name,'type',m.type,'timeout',m.timeout))
             FROM agent_mcp_server ams JOIN mcp_server m ON m.id=ams.mcp_server_id
             JOIN agent_session s ON s.agent_id=ams.agent_id WHERE s.id='$SID'),
  'messages', (SELECT json_group_array(json_object(
                'role',role,'status',status,'modelId',model_id,
                'createdAt',created_at,'updatedAt',updated_at,
                'wallClockMs',(updated_at-created_at),
                'stats',json(COALESCE(stats,'null')),
                'data',json(data)))
             FROM (SELECT * FROM agent_session_message WHERE session_id='$SID' ORDER BY created_at))
);" > "$OUTDIR/session.json"

# ── 5. 收集产物文件（report_artifacts 声明过的 + 工具写过的路径）──────────
ART_LIST="$OUTDIR/.artifact-paths"
{
  # a) report_artifacts 明确声明的产物
  q "SELECT DISTINCT json_extract(a.value,'\$.path')
     FROM agent_session_message m, json_each(json_extract(m.data,'\$.parts')) p,
          json_each(json_extract(p.value,'\$.input.artifacts')) a
     WHERE m.session_id='$SID' AND json_extract(p.value,'\$.toolName') LIKE '%report_artifacts%';"
  # b) 会话工作目录里的文件（兜底：没调用 report_artifacts 的情况）
  WS="$USERDATA/Data/Agents/$SID"
  [ -d "$WS" ] && find "$WS" -type f -not -name '.*' -size -80M 2>/dev/null | head -50
} | sed '/^$/d' | sort -u > "$ART_LIST"

COPIED=0; SKIPPED=0
while IFS= read -r p; do
  [ -f "$p" ] || continue
  sz=$(stat -f%z "$p" 2>/dev/null || stat -c%s "$p" 2>/dev/null || echo 0)
  if [ "$sz" -gt 83886080 ]; then echo "   ⚠️  跳过大文件（>80MB）：$p"; SKIPPED=$((SKIPPED+1)); continue; fi
  cp "$p" "$OUTDIR/artifacts/" 2>/dev/null && COPIED=$((COPIED+1)) || true
done < "$ART_LIST"
rm -f "$ART_LIST"
echo "📎 产物文件：已收集 $COPIED 个${SKIPPED:+，跳过 $SKIPPED 个过大文件}"

# ── 6. 说明文件 ────────────────────────────────────────────────────────────
APPVER=$( { q "SELECT value FROM setting WHERE key LIKE '%version%' LIMIT 1;" 2>/dev/null || true; } )
cat > "$OUTDIR/README.txt" <<EOF
Cherry Studio 会话回放包
========================
会话标题 : $SNAME
会话 ID  : $SID
消息条数 : $NMSG
累计耗时 : $((TOTAL_MS/1000)) 秒
采集时间 : $(date '+%Y-%m-%d %H:%M:%S')
数据目录 : $USERDATA
应用版本 : ${APPVER:-（未知）}

内容
----
session.json  完整对话：每轮文本、每次工具调用的名称/入参/输出、
              每轮真实耗时(wallClockMs)、模型与 agent 配置、MCP 服务清单
artifacts/    这次运行产出的文件（PDF/表格/图片等）

不含 API Key、provider 地址、MCP 环境变量。
对话正文原样导出——若含敏感信息，请删改后再发送。
EOF

# ── 7. 打包 ────────────────────────────────────────────────────────────────
DEST="$HOME/Desktop/cherry-replay-$STAMP.zip"
( cd "$OUTDIR" && zip -qr "$DEST" . )
rm -rf "$OUTDIR"

SIZE=$(du -h "$DEST" | cut -f1 | tr -d ' ')
echo
echo "✅ 打包完成：$DEST（$SIZE）"
echo "   把这个 zip 发给对方即可。"
