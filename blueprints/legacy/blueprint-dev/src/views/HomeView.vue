<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { registry } from 'virtual:blueprint-registry'
import type { BlueprintEntry } from '@/types/blueprint'

const router = useRouter()
const blueprints = ref<BlueprintEntry[]>(registry)
const isLoading = ref(false)

function openPreview(blueprintId: string) {
  router.push(`/preview/${blueprintId}`)
}
</script>

<template>
  <div class="home-page">
    <header class="header">
      <h1>Blueprint Dev Environment</h1>
      <p>Select a blueprint to preview in Sandpack</p>
    </header>

    <div v-if="isLoading" class="loading">
      <div class="spinner"></div>
      <p>Loading blueprints...</p>
    </div>

    <div v-else-if="blueprints.length === 0" class="empty">
      <p>No blueprints found. Add JSON files to src/blueprints/</p>
    </div>

    <div v-else class="blueprint-grid">
      <div
        v-for="bp in blueprints"
        :key="bp.blueprintId"
        class="blueprint-card"
        @click="openPreview(bp.blueprintId)"
      >
        <div class="card-header">
          <span class="framework-badge" :class="bp.framework">
            {{ bp.framework }}
          </span>
        </div>
        <h3>{{ bp.name }}</h3>
        <p>{{ bp.description }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-page {
  min-height: 100%;
  padding: 2rem;
  color: #c9d1d9;
}

.header {
  text-align: center;
  margin-bottom: 3rem;
}

.header h1 {
  font-size: 2rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.header p {
  color: #8b949e;
  font-size: 1rem;
}

.loading, .empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem;
  color: #8b949e;
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

.blueprint-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}

.blueprint-card {
  background-color: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 1.5rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.blueprint-card:hover {
  border-color: #58a6ff;
  transform: translateY(-2px);
}

.card-header {
  margin-bottom: 1rem;
}

.framework-badge {
  display: inline-block;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  border-radius: 4px;
}

.framework-badge.vue {
  background-color: rgba(66, 184, 131, 0.2);
  color: #42b883;
}

.framework-badge.react {
  background-color: rgba(97, 218, 251, 0.2);
  color: #61dafb;
}

.blueprint-card h3 {
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.blueprint-card p {
  font-size: 0.875rem;
  color: #8b949e;
  margin: 0;
}
</style>
