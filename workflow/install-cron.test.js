import test from 'node:test'
import assert from 'node:assert/strict'
import { plistXml, propagatedEnvironmentXml } from './install-cron.mjs'

test('cron plist propagates non-secret Feishu collector settings', () => {
  const env = {
    WORKBOARD_FEISHU_BIN: '~/feishu-export-public/bin/feishu-export',
    WORKBOARD_FEISHU_COOKIES: '~/Library/Application Support/feishu-export/cookies.json',
    WORKBOARD_FEISHU_OUTPUT_DIR: '~/feishu_export/daily',
    WORKBOARD_FEISHU_TIMEOUT_MS: '180000',
    FEISHU_BASE_URL: 'https://tenant.example.com?a=1&b=2',
    FEISHU_CHAT_TIMEOUT_MS: '45000',
  }
  const entries = propagatedEnvironmentXml(env)
  assert.match(entries, /WORKBOARD_FEISHU_BIN/) 
  assert.match(entries, /FEISHU_CHAT_TIMEOUT_MS/)
  assert.match(entries, /https:\/\/tenant\.example\.com\?a=1&amp;b=2/)
  assert.doesNotMatch(entries, /SUPABASE_SERVICE_ROLE_KEY|WEBHOOK|SIGNING_SECRET/i)
  assert.match(plistXml(), /EnvironmentVariables/)
})
