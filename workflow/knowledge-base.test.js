import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

test('用户在更新对话中的已确认纠正已沉淀到知识库和来源映射', () => {
  const knowledge = fs.readFileSync(path.join(root, 'docs', 'KNOWLEDGE_BASE.md'), 'utf8')
  assert.match(knowledge, /Jigsolitaire Unity 项目接手.*宁静华容道问题修复\/验收测试工具.*同一件/s)
  assert.match(knowledge, /“扎烦恼”是私人项目.*不上工作看板/)
  assert.match(knowledge, /Fantasy CMS AI 打标签功能优化.*不归入「涂色产品 AI 批量打标支持」/)
  assert.match(knowledge, /成就系统相关 Bug 已全部修复.*等待产品经理验收/)
  assert.match(knowledge, /圣诞主题图库和日更图排期口径.*不是宗意负责/)

  const sourceMap = JSON.parse(fs.readFileSync(path.join(root, 'workflow', 'source-map.json'), 'utf8'))
  assert.ok(sourceMap.ignored_cwd.some((rule) => rule.pattern === '扎烦恼'))
  assert.ok(sourceMap.codex_cwd.some((rule) => rule.pattern === 'Jigsolitaire_Unity'))
})

test('日常更新 skill 要求完整预览直出并在同一轮维护知识库', () => {
  const skill = fs.readFileSync(path.join(root, 'workflow', 'dashboard-update.skill.md'), 'utf8')
  assert.match(skill, /最终回复必须逐项完整转发/)
  assert.match(skill, /不得只给数量摘要/)
  assert.match(skill, /同一轮立即更新知识库/)
  assert.match(skill, /无需固定口令/)
})
