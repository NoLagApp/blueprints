import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('./views/HomeView.vue')
    },
    {
      path: '/preview/:blueprintId',
      name: 'preview',
      component: () => import('./views/PreviewView.vue')
    }
  ]
})

const app = createApp(App)
app.use(router)
app.mount('#app')
