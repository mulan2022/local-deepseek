import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const manifest = require.resolve('@rspack/cli/package.json')
const { bin } = JSON.parse(readFileSync(manifest, 'utf8'))
const executable = resolve(dirname(manifest), typeof bin === 'string' ? bin : bin.rspack)
const result = spawnSync(process.execPath, [executable, 'build', '-c', 'rspack.config.ts'], {
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
