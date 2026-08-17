#!/usr/bin/env node
// ============================================================
// 安装「每天下班前自动拉取看板数据」的定时任务（macOS launchd）
// 工作日 11:00/15:30/19:30 运行 workflow/prepare.mjs --no-advance（只拉数据、不推进增量游标、不分析）。
// 分析/写入保持由 Agent 按需触发（需要 LLM 判断，且用户确认更稳）。
//
// 用法: npm run dashboard:cron:install
// 卸载: npm run dashboard:cron:uninstall
// 状态: launchctl list | grep workdashboard
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const NODE_BIN = process.execPath
const LABEL = 'com.zongyi.workdashboard.prepare'
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG_OUT = path.join(HOME, 'Library', 'Logs', 'work-dashboard-prepare.out.log')
const LOG_ERR = path.join(HOME, 'Library', 'Logs', 'work-dashboard-prepare.err.log')

// 定时计划：工作日（周一=1 … 周五=5），每天 11:00 / 15:30 / 19:30
const SCHEDULE = [
  { weekday: 1, hour: 11, minute: 0 },
  { weekday: 2, hour: 11, minute: 0 },
  { weekday: 3, hour: 11, minute: 0 },
  { weekday: 4, hour: 11, minute: 0 },
  { weekday: 5, hour: 11, minute: 0 },
  { weekday: 1, hour: 15, minute: 30 },
  { weekday: 2, hour: 15, minute: 30 },
  { weekday: 3, hour: 15, minute: 30 },
  { weekday: 4, hour: 15, minute: 30 },
  { weekday: 5, hour: 15, minute: 30 },
  { weekday: 1, hour: 19, minute: 30 },
  { weekday: 2, hour: 19, minute: 30 },
  { weekday: 3, hour: 19, minute: 30 },
  { weekday: 4, hour: 19, minute: 30 },
  { weekday: 5, hour: 19, minute: 30 },
]

function sh(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function plistXml() {
  const intervals = SCHEDULE.map(
    (s) => `    <dict>
      <key>Weekday</key><integer>${s.weekday}</integer>
      <key>Hour</key><integer>${s.hour}</integer>
      <key>Minute</key><integer>${s.minute}</integer>
    </dict>`,
  ).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${path.join(ROOT, 'workflow', 'prepare.mjs')}</string>
    <string>--no-advance</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>${LOG_OUT}</string>
  <key>StandardErrorPath</key><string>${LOG_ERR}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`
}

function install() {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true })
  fs.mkdirSync(path.dirname(LOG_OUT), { recursive: true })
  // 先卸载旧的再安装，保证幂等
  unload()
  fs.writeFileSync(PLIST, plistXml())
  if (!sh('launchctl', ['load', PLIST])) {
    console.error(`❌ launchctl load 失败`)
    process.exit(1)
  }
  console.log(`✅ 定时任务已安装（工作日 11:00/15:30/19:30 自动拉取数据，--no-advance 只拉不推进游标）`)
  console.log(`   plist: ${PLIST}`)
  console.log(`   日志: ${LOG_OUT}`)
  console.log(`   校验: launchctl list | grep ${LABEL}`)
}

function unload() {
  if (fs.existsSync(PLIST)) sh('launchctl', ['unload', PLIST])
}

function uninstall() {
  unload()
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST)
  console.log('✅ 定时任务已卸载')
}

const cmd = process.argv[2]
if (cmd === 'uninstall') uninstall()
else install()
