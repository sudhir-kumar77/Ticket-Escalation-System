import fs from 'node:fs'
import path from 'node:path'

const srcDir = 'apps/api/src'
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'))

const routes = []
for (const file of files) {
  const content = fs.readFileSync(path.join(srcDir, file), 'utf8')
  const lines = content.split('\n')
  lines.forEach((line, idx) => {
    const match = line.match(/app\.(get|post|patch|put|delete)(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/i)
    if (match) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: file,
        line: idx + 1
      })
    }
  })
}

console.log(`TOTAL REGISTERED ROUTES: ${routes.length}`)
const byMethod = {}
for (const r of routes) {
  byMethod[r.method] = (byMethod[r.method] || 0) + 1
}
console.log('BY METHOD:', JSON.stringify(byMethod))
console.log(JSON.stringify(routes, null, 2))
