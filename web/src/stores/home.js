import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchHomeSummary } from '@/api/homePublic';

/**
 * 主页首屏数据（免票接口）
 * 走裸 fetch（见 api/homePublic.js），不等待 PoW —— 首访即可见名片/关于/友链。
 */
export const useHomeStore = defineStore('home', () => {
  const summary = ref(null);
  const loading = ref(false);
  const failed = ref(false);

  async function load(force = false) {
    if (summary.value && !force) return summary.value;
    loading.value = true;
    failed.value = false;
    try {
      summary.value = await fetchHomeSummary();
    } catch (e) {
      failed.value = true;
    } finally {
      loading.value = false;
    }
    return summary.value;
  }

  return { summary, loading, failed, load };
});
