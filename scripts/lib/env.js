// ============================================================
// 极简 .env 加载器（不引入额外依赖）
// 读取项目根目录 .env，合并到 process.env（进程已有变量优先）。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function loadEnv() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const envPath = path.join(root, '.env')
  const parsed = {}
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      parsed[key] = val
    }
  }
  return { ...parsed, ...process.env }
}
