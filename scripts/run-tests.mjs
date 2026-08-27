#!/usr/bin/env node
// Keep the test inventory in one place. Default output is deliberately compact:
// a green update should not consume Agent context line-by-line, while failures
// still make the process non-zero and print their diagnostics through Node's
// reporter. `npm run test:verbose` is available for human investigation.

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const TEST_FILES = [
  'scripts/agent.test.js',
  'scripts/feedback.test.js',
  'scripts/notify-cards.test.js',
  'scripts/plan.test.js',
  'scripts/plan-today.test.js',
  'scripts/schedule-view.test.js',
  'scripts/dashboard-signals.test.js',
  'scripts/daily-report.test.js',
  'scripts/taskcolor.test.js',
  'scripts/decision.test.js',
  'scripts/format.test.js',
  'scripts/notification-sql.test.js',
  'scripts/notification-status.test.js',
  'scripts/notification-delivery.test.js',
  'scripts/release-status.test.js',
  'scripts/deploy-workflow.test.js',
  'scripts/dsh-summary.test.js',
  'scripts/repo-doctor.test.js',
  'scripts/test-runner.test.js',
  'workflow/review-packet.test.js',
  'workflow/prepare.test.js',
  'workflow/update.test.js',
  'workflow/verify.test.js',
  'workflow/pending.test.js',
  'workflow/publish.test.js',
  'workflow/apply-safety.test.js',
  'workflow/status.test.js',
  'workflow/health.test.js',
  'workflow/stewardship.test.js',
  'workflow/install-cron.test.js',
  'workflow/install-dashboard-skill.test.js',
  'workflow/install-dashboard-steward-skill.test.js',
]

export function buildTestArgs({ verbose = false } = {}) {
  return [
    '--experimental-strip-types',
    ...(verbose ? [] : ['--test-reporter=dot']),
    '--test',
    ...TEST_FILES,
  ]
}

export function main(argv = process.argv.slice(2)) {
  const result = spawnSync(process.execPath, buildTestArgs({ verbose: argv.includes('--verbose') }), { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
