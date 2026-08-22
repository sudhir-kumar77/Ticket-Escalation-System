import fs from 'node:fs'
import path from 'node:path'

const srcDir = 'apps/api/src'
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'))

const routes = []
for (const file of files) {
  const content = fs.readFileSync(path.join(srcDir, file), 'utf8')
  // Match app.get, app.post, etc across multiple lines
  const regex = /app\.(get|post|patch|put|delete)(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/gi
  let match
  while ((match = regex.exec(content)) !== null) {
    const isTestRoute = match[2].includes('/test/')
    const isHealthRoute = match[2].startsWith('/health')
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file: file,
      isTestRoute,
      isHealthRoute
    })
  }
}

console.log(`TOTAL DETECTED ROUTES: ${routes.length}`)
const prodRoutes = routes.filter(r => !r.isTestRoute)
const testRoutes = routes.filter(r => r.isTestRoute)
const healthRoutes = routes.filter(r => r.isHealthRoute)
const apiProdRoutes = routes.filter(r => !r.isTestRoute && !r.isHealthRoute)

console.log(`PRODUCTION ROUTES (INCLUDING HEALTH): ${prodRoutes.length}`)
console.log(`API PRODUCTION ROUTES (/v1/*): ${apiProdRoutes.length}`)
console.log(`TEST-ONLY ROUTES: ${testRoutes.length}`)

const byMethod = {}
for (const r of prodRoutes) {
  byMethod[r.method] = (byMethod[r.method] || 0) + 1
}
console.log('PROD BY METHOD:', JSON.stringify(byMethod))
console.log('ALL PROD ROUTES:', JSON.stringify(prodRoutes, null, 2))
