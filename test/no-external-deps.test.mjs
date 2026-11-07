/**
 * 静态不变式：插件不得依赖任何外部包。
 *
 * 这不是风格洁癖，是对 2026-11-05 那次事故的防线。事故链条是：
 *   link: 安装 → index.js `import '@deepseek-ai/dsh-llm'` → 宿主解析不到（Electron/asar 环境）
 *   → import 阶段抛错 → 插件树加载失败 → App 把整个 profile 重置成最小模板
 *
 * import 阶段的失败发生在插件 `apply` 之前，插件自己**接不住**。唯一可靠的解法是
 * 根本不 import。这个测试把这条约束钉死：谁再往源码里加裸包名 import，测试就红。
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 收集要检查的源码文件（不含 test/ 与 node_modules/）。 */
async function sources() {
  const out = [join(ROOT, 'index.js'), join(ROOT, 'client.js')]
  for (const file of await readdir(join(ROOT, 'lib'))) {
    if (file.endsWith('.js')) out.push(join(ROOT, 'lib', file))
  }
  return out
}

/**
 * 命中裸包名 import / require 的行。
 * 相对路径（./ ../）不算外部依赖；`node:` 内建模块也不算——它们随 Node 一起在，
 * 不经过宿主解析，不会重演 2026-11-05 那次 import 崩溃。
 */
const BARE = /(?:^|\n)\s*(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*)['"](?!node:)([^'"./][^'"]*)['"]/g

test('宿主与浏览器半边都不 import 任何外部包', async () => {
  const offenders = []
  for (const path of await sources()) {
    const text = await readFile(path, 'utf8')
    // 注释里提到包名是允许的：先剥掉行注释与块注释再扫。
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const match of stripped.matchAll(BARE)) {
      offenders.push(`${path.slice(ROOT.length)} → ${match[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `发现外部包依赖：\n${offenders.join('\n')}`)
})

test('client.js 只用 __ModuleLoader__ 的 require，且只取 react', async () => {
  const text = await readFile(join(ROOT, 'client.js'), 'utf8')
  const required = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  const outsideFactory = required.filter((name) => name !== 'react')
  assert.deepEqual(outsideFactory, [], `client.js 只允许 require('react')，实际：${required.join(', ')}`)
})
