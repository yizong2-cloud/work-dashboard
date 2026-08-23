import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_REGISTRY = path.join(ROOT, 'workflow', 'repository-registry.json')

export function expandHome(value, home = os.homedir()) {
  return value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value
}

export function inspectRegistry(registry, adapters = {}) {
  const home = adapters.home || os.homedir()
  const exists = adapters.exists || fs.existsSync
  const isGit = adapters.isGit || ((repoPath) => exists(path.join(repoPath, '.git')))
  const gitStatus = adapters.gitStatus || ((repoPath) => {
    try {
      return execFileSync('git', ['-C', repoPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })
  const commandExists = adapters.commandExists || ((command) => {
    try {
      execFileSync('/usr/bin/env', ['which', command], {stdio: 'ignore'})
      return true
    } catch {
      return false
    }
  })

  const repositories = registry.repositories.map((repo) => {
    const resolvedPath = expandHome(repo.path, home)
    const present = exists(resolvedPath)
    const gitOk = repo.kind !== 'git' || (present && isGit(resolvedPath))
    const agentsOk = !repo.agentsRequired || (present && exists(path.join(resolvedPath, 'AGENTS.md')))
    const issues = []
    const advisories = []
    if (!present) issues.push('目录不存在')
    if (present && !gitOk) issues.push('不是 Git 仓库')
    if (present && !agentsOk) issues.push('缺少 AGENTS.md')
    if (repo.trackWorktree && present && gitOk) {
      const status = gitStatus(resolvedPath)
      if (status === null) advisories.push('无法读取 Git 工作区状态')
      else if (status) advisories.push('有未提交改动（当前采集代码版本不可追溯）')
    }
    return {...repo, resolvedPath, present, gitOk, agentsOk, issues, advisories}
  })

  const commands = Object.entries(registry.commands).map(([command, meta]) => ({
    command,
    ...meta,
    installed: commandExists(command),
  }))
  return {repositories, commands}
}

export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'))
}

function printReport(report) {
  console.log('仓库检查')
  for (const repo of report.repositories) {
    const status = repo.issues.length ? `WARN: ${repo.issues.join('、')}` : 'OK'
    console.log(`${status}\t${repo.id}\t${repo.resolvedPath}`)
    for (const advisory of repo.advisories) console.log(`NOTE\t${repo.id}\t${advisory}`)
  }
  console.log('\nCLI 检查')
  for (const command of report.commands) {
    console.log(`${command.installed ? 'OK' : 'WARN: 未安装'}\t${command.command}\t${command.sourceRepo}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json')
  const report = inspectRegistry(loadRegistry())
  if (json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  process.exitCode = report.repositories.some((repo) => repo.issues.length) ? 1 : 0
}
