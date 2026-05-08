import { Plugin } from 'vite'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface BlueprintMetadata {
  blueprintId: string
  name: string
  description?: string
  version?: string
  category?: string
  framework: 'vue' | 'react'
  dependencies?: Record<string, string>
  config?: Record<string, unknown>
}

interface Blueprint extends BlueprintMetadata {
  files: Record<string, string>
}

interface BlueprintEntry {
  blueprintId: string
  name: string
  description?: string
  framework: string
}

const VIRTUAL_MODULE_ID = 'virtual:blueprints'
const RESOLVED_VIRTUAL_MODULE_ID = '\0' + VIRTUAL_MODULE_ID

const VIRTUAL_REGISTRY_ID = 'virtual:blueprint-registry'
const RESOLVED_VIRTUAL_REGISTRY_ID = '\0' + VIRTUAL_REGISTRY_ID

/**
 * Vite plugin that loads blueprints from folder structures.
 *
 * Scans sibling directories for blueprint folders containing:
 * - blueprint.json (metadata: name, description, framework, dependencies)
 * - src/ folder with actual source files
 *
 * Usage:
 *   import { getBlueprint } from 'virtual:blueprints'
 *   import { registry } from 'virtual:blueprint-registry'
 */
export function blueprintsPlugin(): Plugin {
  const blueprintsDir = path.resolve(__dirname, '..')

  // Cache for blueprints
  let blueprintCache: Map<string, Blueprint> = new Map()
  let registryCache: BlueprintEntry[] = []

  function scanBlueprints(): void {
    blueprintCache.clear()
    registryCache = []

    const entries = fs.readdirSync(blueprintsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'blueprint-dev') continue // Skip self
      if (entry.name.startsWith('.')) continue // Skip hidden

      const blueprintPath = path.join(blueprintsDir, entry.name)
      const metadataPath = path.join(blueprintPath, 'blueprint.json')

      if (!fs.existsSync(metadataPath)) continue

      try {
        const metadata: BlueprintMetadata = JSON.parse(
          fs.readFileSync(metadataPath, 'utf-8')
        )

        // Read all files from the blueprint folder
        const files = readFilesRecursively(blueprintPath, blueprintPath)

        // Remove blueprint.json from files (it's metadata, not source)
        delete files['blueprint.json']

        const blueprint: Blueprint = {
          ...metadata,
          files,
        }

        blueprintCache.set(metadata.blueprintId, blueprint)
        registryCache.push({
          blueprintId: metadata.blueprintId,
          name: metadata.name,
          description: metadata.description,
          framework: metadata.framework,
        })
      } catch (err) {
        console.warn(`[blueprints-plugin] Failed to load blueprint from ${entry.name}:`, err)
      }
    }

    console.log(`[blueprints-plugin] Loaded ${blueprintCache.size} blueprints:`,
      Array.from(blueprintCache.keys()).join(', '))
  }

  function readFilesRecursively(
    dir: string,
    baseDir: string,
    files: Record<string, string> = {}
  ): Record<string, string> {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')

      // Skip certain files/folders
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'node_modules') continue
      if (entry.name === 'dist') continue
      if (entry.name === 'yarn.lock') continue
      if (entry.name === 'package-lock.json') continue

      if (entry.isDirectory()) {
        readFilesRecursively(fullPath, baseDir, files)
      } else {
        // Only include source files
        const ext = path.extname(entry.name).toLowerCase()
        const includedExtensions = [
          '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
          '.css', '.scss', '.less', '.sass',
          '.html', '.json', '.md',
          '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico'
        ]

        if (includedExtensions.includes(ext) || entry.name === 'package.json') {
          try {
            // For images, we'd need to handle differently, but for now skip binary
            if (['.png', '.jpg', '.jpeg', '.gif', '.ico'].includes(ext)) {
              // Skip binary files for now
              continue
            }
            files[relativePath] = fs.readFileSync(fullPath, 'utf-8')
          } catch (err) {
            console.warn(`[blueprints-plugin] Failed to read ${relativePath}:`, err)
          }
        }
      }
    }

    return files
  }

  return {
    name: 'vite-plugin-blueprints',

    buildStart() {
      scanBlueprints()
    },

    configureServer(server) {
      // Watch for changes in blueprint folders
      const watcher = server.watcher

      // Re-scan when files change in blueprint folders
      watcher.on('change', (file) => {
        if (file.includes(blueprintsDir) && !file.includes('blueprint-dev')) {
          console.log(`[blueprints-plugin] File changed: ${file}, rescanning...`)
          scanBlueprints()

          // Invalidate virtual modules
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID)
          if (mod) {
            server.moduleGraph.invalidateModule(mod)
          }
          const regMod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_REGISTRY_ID)
          if (regMod) {
            server.moduleGraph.invalidateModule(regMod)
          }

          // Send HMR update
          server.ws.send({ type: 'full-reload' })
        }
      })

      // Also watch for new files
      watcher.on('add', (file) => {
        if (file.includes(blueprintsDir) && !file.includes('blueprint-dev')) {
          scanBlueprints()
          server.ws.send({ type: 'full-reload' })
        }
      })
    },

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID
      }
      if (id === VIRTUAL_REGISTRY_ID) {
        return RESOLVED_VIRTUAL_REGISTRY_ID
      }
      // Handle dynamic blueprint imports
      if (id.startsWith('virtual:blueprint:')) {
        return '\0' + id
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_REGISTRY_ID) {
        return `export const registry = ${JSON.stringify(registryCache, null, 2)};`
      }

      if (id === RESOLVED_VIRTUAL_MODULE_ID) {
        // Generate code that exports all blueprints
        const blueprintExports = Array.from(blueprintCache.entries())
          .map(([id, bp]) => `  "${id}": ${JSON.stringify(bp)}`)
          .join(',\n')

        return `
const blueprints = {
${blueprintExports}
};

export function getBlueprint(id) {
  return blueprints[id] || null;
}

export function getAllBlueprints() {
  return Object.values(blueprints);
}

export const blueprintIds = ${JSON.stringify(Array.from(blueprintCache.keys()))};
`
      }

      // Handle dynamic blueprint imports: virtual:blueprint:chat-app-vue
      if (id.startsWith('\0virtual:blueprint:')) {
        const blueprintId = id.replace('\0virtual:blueprint:', '')
        const blueprint = blueprintCache.get(blueprintId)
        if (blueprint) {
          return `export default ${JSON.stringify(blueprint)};`
        }
        return `export default null;`
      }
    },
  }
}

export default blueprintsPlugin
