import { defineStore } from 'pinia';
import { ref } from 'vue';
import { statsApi } from '@/api';

/** 后台数据：待审事项角标 */
export const useAdminStore = defineStore('admin', () => {
  const pending = ref({ comments: 0, links: 0, messages: 0 });
  const loaded = ref(false);

  async function fetchPending() {
    try {
      const data = await statsApi.dashboard();
      pending.value = data.pending;
      loaded.value = true;
    } catch (e) {
      /* 忽略 */
    }
  }

  function totalPending() {
    return pending.value.comments + pending.value.links + pending.value.messages;
  }

  return { pending, loaded, fetchPending, totalPending };
});
