import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSkillCopies, installSkillCopies, skillTargets } from './install-dashboard-skill.mjs'

test('dashboard skill installs the canonical contract into the user discovery root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-skill-'))
  const source = path.join(home, 'work-dashboard', 'workflow', 'dashboard-update.skill.md')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'canonical dashboard workflow\n')

  const targets = skillTargets(home)
  assert.deepEqual(targets, [
    path.join(home, '.agents', 'skills', 'dashboard-update', 'SKILL.md'),
  ])
  assert.equal(checkSkillCopies(source, targets).ok, false)

  installSkillCopies(source, targets)
  assert.equal(checkSkillCopies(source, targets).ok, true)
  assert.equal(fs.readFileSync(targets[0], 'utf8'), 'canonical dashboard workflow\n')

  fs.rmSync(home, { recursive: true, force: true })
})

test('dashboard skill check reports the exact drifted target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-skill-drift-'))
  const source = path.join(home, 'canonical.md')
  const targets = skillTargets(home)
  fs.writeFileSync(source, 'canonical\n')
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'canonical\n')
  }
  fs.writeFileSync(targets[0], 'stale\n')

  assert.deepEqual(checkSkillCopies(source, targets), {
    ok: false,
    missing: [],
    drifted: [targets[0]],
  })

  fs.rmSync(home, { recursive: true, force: true })
})

test('manual Feishu export command uses the same canonical chat exporter', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(packageJson.scripts['feishu:export'], /^~\/Workspace\/feishu-export-public\/bin\/feishu-export\b/)
  assert.equal(packageJson.scripts['update:export'], undefined)
})
