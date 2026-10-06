import { ref } from 'vue';

/** 管理后台统一断点：≤820px 视为窄屏（与各视图媒体查询保持一致） */
export const BREAKPOINT_ADMIN = 820;

const mq =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(`(max-width: ${BREAKPOINT_ADMIN}px)`)
    : null;

/** 单例响应式状态：Layout 与各管理视图共用同一个监听，避免 N 份 matchMedia */
const isMobile = ref(mq ? mq.matches : false);
let bound = false;

if (mq && !bound) {
  bound = true;
  mq.addEventListener('change', (e) => {
    isMobile.value = e.matches;
  });
}

/** 管理后台窄屏标记：表格列裁剪、操作列解固定、表单纵排等行为依据 */
export function useIsMobile() {
  return isMobile;
}
