import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkStewardSkillCopies, installStewardSkillCopies, stewardSkillTargets } from './install-dashboard-steward-skill.mjs'

test('dashboard steward skill installs a canonical copy into the Agent discovery root', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-steward-'))
  const source = path.join(home, 'work-dashboard', 'workflow', 'dashboard-steward.skill.md')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'canonical stewardship workflow\n')

  const targets = stewardSkillTargets(home)
  assert.deepEqual(targets, [path.join(home, '.agents', 'skills', 'dashboard-steward', 'SKILL.md')])
  assert.equal(checkStewardSkillCopies(source, targets).ok, false)
  installStewardSkillCopies(source, targets)
  assert.equal(checkStewardSkillCopies(source, targets).ok, true)

  fs.rmSync(home, { recursive: true, force: true })
})
