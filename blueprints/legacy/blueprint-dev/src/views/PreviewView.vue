<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import {
  SandpackProvider,
  SandpackPreview,
  SandpackConsole,
} from 'sandpack-vue3'
import { getBlueprint } from 'virtual:blueprints'
import type { Blueprint } from '@/types/blueprint'

/**
 * PreviewView - Blueprint Preview Page
 *
 * Renders a blueprint using Sandpack for local development.
 * Loads blueprints from folder structure via Vite plugin.
 *
 * Route: /preview/:blueprintId
 * With token: /preview/:blueprintId?token=<accessToken>&expiresAt=<isoDate>
 */

const route = useRoute()

const blueprintId = computed(() => route.params.blueprintId as string)

// Token from URL query: /preview/:blueprintId?token=xyz
const previewToken = computed(() => route.query.token as string | undefined)
const tokenExpiresAt = computed(() => route.query.expiresAt as string | undefined)

// State
const blueprint = ref<Blueprint | null>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)
const showConsole = ref(false)

// Load blueprint data
onMounted(() => {
  loadBlueprint()
})

function loadBlueprint() {
  isLoading.value = true
  error.value = null

  try {
    // Load blueprint from virtual module (reads from folder structure)
    const bp = getBlueprint(blueprintId.value)
    if (!bp) {
      throw new Error(`Blueprint "${blueprintId.value}" not found`)
    }
    blueprint.value = bp
  } catch (err) {
    console.error('Failed to load blueprint:', err)
    error.value = err instanceof Error ? err.message : 'Failed to load blueprint'
  } finally {
    isLoading.value = false
  }
}

// Token injection code - must be placed AFTER imports (ES module requirement)
const tokenInjectionCode = computed(() => {
  if (!previewToken.value) return ''
  return `
// NoLag Preview Token (auto-injected)
console.log('[Token Injection] Setting NOLAG_PREVIEW_TOKEN...');
window.NOLAG_PREVIEW_TOKEN = ${JSON.stringify(previewToken.value)};
window.NOLAG_TOKEN_EXPIRES_AT = ${JSON.stringify(tokenExpiresAt.value || null)};
console.log('[Token Injection] Token set:', window.NOLAG_PREVIEW_TOKEN?.substring(0, 20) + '...');
`
})

// Find the position after all imports to inject token code
function injectTokenAfterImports(content: string, tokenCode: string): string {
  // Find the last import statement
  const importRegex = /^(import\s+.*?['"].*?['"];?\s*)+/gm
  const matches = content.match(importRegex)

  if (matches) {
    // Find where imports end
    let lastImportEnd = 0
    let match
    const regex = /^import\s+.*?['"].*?['"];?\s*$/gm
    while ((match = regex.exec(content)) !== null) {
      lastImportEnd = match.index + match[0].length
    }

    // Insert token code after imports
    return content.slice(0, lastImportEnd) + '\n' + tokenCode + content.slice(lastImportEnd)
  }

  // No imports found, prepend
  return tokenCode + content
}

// Convert files to Sandpack format with token injection
const sandpackFiles = computed(() => {
  if (!blueprint.value?.files) return {}

  const files: Record<string, { code: string; active?: boolean }> = {}
  const fw = blueprint.value?.framework || 'vue'

  console.log('[PreviewView] Building sandpackFiles:', {
    framework: fw,
    hasToken: !!previewToken.value,
    token: previewToken.value?.substring(0, 20) + '...',
    filePaths: Object.keys(blueprint.value.files),
  })

  for (const [path, content] of Object.entries(blueprint.value.files)) {
    const sandpackPath = path.startsWith('/') ? path : `/${path}`

    // Inject token into main entry files
    if (previewToken.value) {
      // Vue3 template uses /src/main.js - we need to use this path
      const isVueEntry = sandpackPath === '/src/main.js' || sandpackPath === '/src/main.ts'
      // React uses /src/index.js or /src/index.tsx
      const isReactEntry = sandpackPath === '/src/index.js' || sandpackPath === '/src/index.tsx' || sandpackPath === '/index.js'

      if ((fw === 'vue' && isVueEntry) || (fw === 'react' && isReactEntry)) {
        const injectedCode = injectTokenAfterImports(content, tokenInjectionCode.value)
        console.log('[PreviewView] Injecting token into:', sandpackPath)
        console.log('[PreviewView] Original content:', content.substring(0, 200))
        console.log('[PreviewView] Injected content:', injectedCode.substring(0, 400))

        // For Vue, Sandpack expects /src/main.js - copy to both paths
        if (fw === 'vue' && sandpackPath === '/src/main.ts') {
          files['/src/main.js'] = { code: injectedCode }
          console.log('[PreviewView] Also added as /src/main.js for Sandpack compatibility')
        }
        files[sandpackPath] = { code: injectedCode }
        continue
      }
    }

    files[sandpackPath] = { code: content }
  }

  // Set the main app file as active
  const mainFile = fw === 'react' ? '/src/App.tsx' : '/src/App.vue'
  if (files[mainFile]) {
    files[mainFile].active = true
  }

  return files
})

// Framework for Sandpack template
const framework = computed(() => {
  return (blueprint.value?.framework as 'vue' | 'react') || 'vue'
})

// Check if files have required entry points
const hasValidEntryPoints = computed(() => {
  if (!blueprint.value?.files) return false

  const fileKeys = Object.keys(blueprint.value.files).map(f => f.startsWith('/') ? f : `/${f}`)

  if (framework.value === 'react') {
    return fileKeys.includes('/App.js') || fileKeys.includes('/App.tsx') || fileKeys.includes('/src/App.tsx')
  }

  return fileKeys.includes('/src/App.vue')
})

// Custom setup with dependencies
const customSetup = computed(() => {
  const deps = blueprint.value?.dependencies || {}

  if (framework.value === 'react') {
    return {
      dependencies: {
        'react': '^18.2.0',
        'react-dom': '^18.2.0',
        ...deps,
      },
    }
  }
  return {
    dependencies: {
      'vue': '^3.4.0',
      ...deps,
    },
  }
})

function toggleConsole() {
  showConsole.value = !showConsole.value
}
</script>

<template>
  <div class="preview-page">
    <!-- Loading State -->
    <div v-if="isLoading" class="preview-loading">
      <div class="spinner"></div>
      <p>Loading blueprint...</p>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="preview-error">
      <div class="error-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </div>
      <h2>Unable to load blueprint</h2>
      <p>{{ error }}</p>
      <button class="retry-btn" @click="loadBlueprint">Try Again</button>
    </div>

    <!-- No Files State -->
    <div v-else-if="!blueprint?.files || Object.keys(blueprint.files).length === 0" class="preview-empty">
      <div class="empty-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
      </div>
      <h2>No files in blueprint</h2>
      <p>This blueprint doesn't have any files defined.</p>
    </div>

    <!-- Missing Entry Points -->
    <div v-else-if="!hasValidEntryPoints" class="preview-empty">
      <div class="empty-icon warning">
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      </div>
      <h2>Missing entry files</h2>
      <p>Required: {{ framework === 'react' ? '/src/App.tsx or /App.js' : '/src/App.vue' }}</p>
    </div>

    <!-- Sandpack Preview -->
    <!-- Key forces re-render when token changes -->
    <SandpackProvider
      v-else
      :key="`${blueprintId}-${previewToken || 'no-token'}`"
      :template="framework === 'react' ? 'react' : 'vue3'"
      :files="sandpackFiles"
      :custom-setup="customSetup"
      :options="{
        recompileMode: 'delayed',
        recompileDelay: 500,
        autorun: true,
        autoReload: true,
        externalResources: [
          'https://cdn.tailwindcss.com',
          'https://cdn.jsdelivr.net/npm/daisyui@4.4.19/dist/full.min.css',
        ],
      }"
    >
      <div class="preview-container">
        <!-- Header -->
        <div class="preview-header">
          <div class="header-left">
            <span class="app-name">{{ blueprint?.name || 'Preview' }}</span>
            <span class="powered-by">Powered by NoLag</span>
            <span v-if="previewToken" class="token-badge" title="Real-time messaging enabled">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              Token Active
            </span>
          </div>
          <div class="header-right">
            <button
              class="console-btn"
              :class="{ active: showConsole }"
              @click="toggleConsole"
              title="Toggle console"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="4 17 10 11 4 5"></polyline>
                <line x1="12" y1="19" x2="20" y2="19"></line>
              </svg>
              Console
            </button>
          </div>
        </div>

        <!-- Preview Content -->
        <div class="preview-content">
          <SandpackPreview
            :show-open-in-codesandbox="false"
            :show-refresh-button="true"
            :show-restart-button="true"
          />
        </div>

        <!-- Console Panel -->
        <div v-if="showConsole" class="console-panel">
          <div class="console-header">
            <span>Console</span>
            <button class="close-btn" @click="showConsole = false">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <SandpackConsole />
        </div>
      </div>
    </SandpackProvider>
  </div>
</template>

<style scoped>
.preview-page {
  width: 100vw;
  height: 100vh;
  background-color: #0d1117;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-loading,
.preview-error,
.preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #8b949e;
  text-align: center;
  padding: 2rem;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #30363d;
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.preview-loading p,
.preview-error p,
.preview-empty p {
  font-size: 14px;
  margin: 0;
}

.preview-error h2,
.preview-empty h2 {
  font-size: 18px;
  font-weight: 600;
  color: #c9d1d9;
  margin: 1rem 0 0.5rem;
}

.error-icon,
.empty-icon {
  opacity: 0.5;
}

.empty-icon.warning {
  color: #f59e0b;
  opacity: 0.8;
}

.retry-btn {
  margin-top: 1rem;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  background-color: #238636;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.retry-btn:hover {
  background-color: #2ea043;
}

/* Make SandpackProvider fill the space */
.preview-page :deep(.sp-wrapper) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.preview-page :deep(.sp-layout) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.preview-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 1rem;
  background-color: #161b22;
  border-bottom: 1px solid #30363d;
  min-height: 40px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.app-name {
  font-size: 14px;
  font-weight: 600;
  color: #c9d1d9;
}

.powered-by {
  font-size: 11px;
  color: #8b949e;
  padding: 2px 8px;
  background-color: #21262d;
  border-radius: 4px;
}

.token-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #22c55e;
  padding: 2px 8px;
  background-color: rgba(34, 197, 94, 0.15);
  border-radius: 4px;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.console-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 4px 10px;
  font-size: 12px;
  background: none;
  border: 1px solid #30363d;
  color: #8b949e;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.console-btn:hover {
  background-color: #21262d;
  color: #c9d1d9;
}

.console-btn.active {
  background-color: #388bfd26;
  color: #58a6ff;
  border-color: #388bfd;
}

.preview-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.preview-content :deep(.sp-preview) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.preview-content :deep(.sp-preview-container) {
  flex: 1;
  min-height: 0;
  background: white;
}

.preview-content :deep(.sp-preview-iframe) {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: none;
}

.console-panel {
  border-top: 1px solid #30363d;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  background-color: #161b22;
}

.console-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.375rem 0.75rem;
  background-color: #21262d;
  font-size: 11px;
  font-weight: 500;
  color: #8b949e;
}

.close-btn {
  padding: 2px;
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
}

.close-btn:hover {
  background-color: #30363d;
  color: #c9d1d9;
}

.console-panel :deep(.sp-console) {
  flex: 1;
  overflow: auto;
}
</style>
