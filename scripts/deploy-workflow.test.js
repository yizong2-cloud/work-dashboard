import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const DEPLOY_WORKFLOW = path.join(process.cwd(), '.github', 'workflows', 'deploy.yml')

test('GitHub Pages workflow uses supported Node 24 actions', () => {
  const workflow = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8')
  assert.match(workflow, /actions\/checkout@v7/)
  assert.match(workflow, /actions\/setup-node@v7/)
  assert.match(workflow, /node-version:\s*24/)
  assert.match(workflow, /actions\/upload-pages-artifact@v5/)
  assert.match(workflow, /actions\/deploy-pages@v5/)
  assert.doesNotMatch(workflow, /node-version:\s*20/)
})
