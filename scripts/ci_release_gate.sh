#!/usr/bin/env bash
# 发布质量门：确认该提交的 ci 全绿，否则拒绝构建/推送（镜像与打印客户端两条流水线共用）。
#
# 为什么要等：推 tag 时通常同一条命令也把 main 推了上去（git push origin main v0.1.0），
# ci 与 images 会在同一秒各自起跑。首版门只查「有没有成功的 ci」，把 in-progress 当成
# 没有记录 → v0.1.0 发布被自己拦住（ci 还在跑，images 已经判红）。
# 现在先等该提交的 ci 出结论，再判定。
#
# 用法：ci_release_gate.sh <commit-sha>
#   CI_GATE_TIMEOUT  等 ci 跑完的上限秒数（默认 1800）
#   CI_GATE_POLL     轮询间隔秒数（默认 30）
#   CI_GATE_GRACE    允许 ci run 尚未登记的最长宽限秒数（默认 180，覆盖 Events API 写延迟）
#   CI_GATE_SUBJECT  拒绝时提示的发布对象（默认「镜像」，打印客户端流水线传「打印客户端」）
set -euo pipefail

SHA="${1:?用法: ci_release_gate.sh <commit-sha>}"
TIMEOUT="${CI_GATE_TIMEOUT:-1800}"
POLL="${CI_GATE_POLL:-30}"
GRACE="${CI_GATE_GRACE:-180}"
WORKFLOW="${CI_GATE_WORKFLOW:-ci}"
SUBJECT="${CI_GATE_SUBJECT:-镜像}"

started_at="$(date +%s)"
deadline=$(( started_at + TIMEOUT ))

# 返回 "<成功数> <进行中数> <总数>"
count_ci_runs() {
  gh run list --commit "$SHA" --workflow "$WORKFLOW" --limit 100 \
    --json status,conclusion \
    --jq '[ ([.[]|select(.status=="completed" and .conclusion=="success")]|length),
            ([.[]|select(.status!="completed")]|length),
            length ] | @tsv'
}

fail() {
  echo "::error::$1"
  echo ""
  echo "提交 ${SHA} 的 ${WORKFLOW} 运行记录："
  gh run list --commit "$SHA" --workflow "$WORKFLOW" --limit 10 \
    --json databaseId,event,status,conclusion,createdAt,url \
    --jq '.[] | "  \(.databaseId)  \(.event)  \(.status)/\(.conclusion // "-")  \(.createdAt)  \(.url)"' || true
  exit 1
}

while :; do
  if ! stats="$(count_ci_runs)"; then
    fail "查询 ${WORKFLOW} 运行状态失败（检查 GH_TOKEN 与 actions:read 权限）"
  fi

  IFS=$'\t' read -r ok pending total <<< "$stats"

  if [ "${ok:-0}" -gt 0 ]; then
    echo "✔ 提交 ${SHA} 有 ${ok} 次成功的 ${WORKFLOW} 运行"
    exit 0
  fi

  # ci run 可能还没被 Events API 登记（与 images 同秒创建），先宽限再判失败
  if [ "${total:-0}" -eq 0 ]; then
    if [ "$(date +%s)" -ge $(( started_at + GRACE )) ]; then
      fail "没有 ${WORKFLOW} 运行记录；请先让该提交触发并跑绿 ${WORKFLOW} 再打 tag"
    fi
    echo "尚未查到 ${WORKFLOW} 运行记录，${POLL}s 后重试（宽限 ${GRACE}s）..."
  else
    if [ "${pending:-0}" -gt 0 ]; then
      if [ "$(date +%s)" -ge "$deadline" ]; then
        fail "等待超过 ${TIMEOUT}s，${WORKFLOW} 仍有 ${pending} 个运行未完成"
      fi
      echo "${WORKFLOW} 进行中（${pending} 个未完成），${POLL}s 后重查（剩余 $(( deadline - $(date +%s) ))s）..."
    else
      # 全部跑完却没有一次成功
      fail "该提交的 ${WORKFLOW} 全部未成功（共 ${total} 次），拒绝发布${SUBJECT}"
    fi
  fi

  sleep "$POLL"
done
