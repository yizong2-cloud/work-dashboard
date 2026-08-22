import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const CANONICAL_SKILL = path.join(ROOT, 'workflow', 'dashboard-update.skill.md')

export function skillTargets(home = os.homedir()) {
  return [
    path.join(home, '.agents', 'skills', 'dashboard-update', 'SKILL.md'),
  ]
}

export function checkSkillCopies(source = CANONICAL_SKILL, targets = skillTargets()) {
  const canonical = fs.readFileSync(source)
  const missing = []
  const drifted = []
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      missing.push(target)
      continue
    }
    if (!fs.readFileSync(target).equals(canonical)) drifted.push(target)
  }
  return { ok: missing.length === 0 && drifted.length === 0, missing, drifted }
}

export function installSkillCopies(source = CANONICAL_SKILL, targets = skillTargets()) {
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  return checkSkillCopies(source, targets)
}

function printCheck(result) {
  if (result.ok) {
    console.log('dashboard-update Skill 已与仓库内唯一契约同步')
    return
  }
  for (const target of result.missing) console.error(`缺少 Skill 副本：${target}`)
  for (const target of result.drifted) console.error(`Skill 副本已漂移：${target}`)
  console.error('运行 npm run dashboard:skill:install 重新同步')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.includes('--check') ? checkSkillCopies() : installSkillCopies()
  printCheck(result)
  if (!result.ok) process.exitCode = 1
}
