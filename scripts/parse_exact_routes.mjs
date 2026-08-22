import fs from 'node:fs'
import path from 'node:path'

const srcDir = 'apps/api/src'
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'))

const routes = []

for (const file of files) {
  const content = fs.readFileSync(path.join(srcDir, file), 'utf8')
  const lines = content.split('\n')
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Check for route declaration: app.get, app.post, app.patch, app.delete
    const match = line.match(/app\.(get|post|patch|put|delete)(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/i)
    if (match) {
      const method = match[1].toUpperCase()
      const routePath = match[2]
      const lineNum = i + 1
      
      // Determine auth requirement from handler context
      let authRequirement = 'Public (No Auth)'
      const surroundingCode = lines.slice(i, Math.min(lines.length, i + 35)).join('\n')
      
      if (surroundingCode.includes('authenticatePm')) {
        if (surroundingCode.includes("role !== 'project_manager'") || surroundingCode.includes("actor.role !== 'project_manager'")) {
          authRequirement = 'Project Manager Role Required'
        } else {
          authRequirement = 'Authenticated Staff (PM or Specialist)'
        }
      } else if (surroundingCode.includes('authenticateSession')) {
        authRequirement = 'Authenticated User Session'
      } else if (routePath.startsWith('/health')) {
        authRequirement = 'Public (Unauthenticated Health Probe)'
      } else if (routePath.includes('/test/')) {
        authRequirement = 'Test-Only (Non-Production)'
      }
      
      routes.push({
        method,
        path: routePath,
        module: file,
        line: lineNum,
        authRequirement,
        isTest: routePath.includes('/test/'),
        isHealth: routePath.startsWith('/health'),
        isMutation: ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
      })
    }
  }
}

// Special check for multiline public tracker
if (!routes.find(r => r.path === '/v1/track/:reference')) {
  const trackerContent = fs.readFileSync(path.join(srcDir, 'publicTracker.ts'), 'utf8')
  const lines = trackerContent.split('\n')
  lines.forEach((l, idx) => {
    if (l.includes("'/v1/track/:reference'")) {
      routes.push({
        method: 'GET',
        path: '/v1/track/:reference',
        module: 'publicTracker.ts',
        line: idx + 1,
        authRequirement: 'Public (Regex-Guarded Rate-Limited)',
        isTest: false,
        isHealth: false,
        isMutation: false
      })
    }
  })
}

console.log(JSON.stringify(routes, null, 2))
