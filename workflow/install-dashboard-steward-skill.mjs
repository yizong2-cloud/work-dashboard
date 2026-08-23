import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const CANONICAL_STEWARD_SKILL = path.join(ROOT, 'workflow', 'dashboard-steward.skill.md')

export function stewardSkillTargets(home = os.homedir()) {
  return [path.join(home, '.agents', 'skills', 'dashboard-steward', 'SKILL.md')]
}

export function checkStewardSkillCopies(source = CANONICAL_STEWARD_SKILL, targets = stewardSkillTargets()) {
  const canonical = fs.readFileSync(source)
  const missing = []
  const drifted = []
  for (const target of targets) {
    if (!fs.existsSync(target)) missing.push(target)
    else if (!fs.readFileSync(target).equals(canonical)) drifted.push(target)
  }
  return { ok: missing.length === 0 && drifted.length === 0, missing, drifted }
}

export function installStewardSkillCopies(source = CANONICAL_STEWARD_SKILL, targets = stewardSkillTargets()) {
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  return checkStewardSkillCopies(source, targets)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.includes('--check') ? checkStewardSkillCopies() : installStewardSkillCopies()
  if (result.ok) console.log('dashboard-steward Skill 已与仓库内唯一契约同步')
  else {
    for (const target of [...result.missing, ...result.drifted]) console.error(`Skill 需要同步：${target}`)
    process.exitCode = 1
  }
}
