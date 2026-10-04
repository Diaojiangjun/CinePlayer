import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    {
      path: '/library',
      name: 'library',
      component: () => import('@renderer/views/LibraryView.vue')
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@renderer/views/HistoryView.vue')
    },
    {
      path: '/favorite',
      name: 'favorite',
      component: () => import('@renderer/views/FavoriteView.vue')
    },
    {
      path: '/iptv',
      name: 'iptv',
      component: () => import('@renderer/views/IptvView.vue')
    },
    {
      path: '/collect',
      name: 'collect',
      component: () => import('@renderer/views/CollectView.vue')
    },
    {
      path: '/collect/detail',
      name: 'collect-detail',
      component: () => import('@renderer/views/CollectDetailView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@renderer/views/SettingsView.vue')
    },
    {
      path: '/play',
      name: 'play',
      component: () => import('@renderer/views/PlayView.vue')
    }
  ]
})

export default router
