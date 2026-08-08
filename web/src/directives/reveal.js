/**
 * 滚动揭示指令 v-reveal
 * 用法：
 *   <div v-reveal>单个元素</div>
 *   <div v-reveal="'stagger'">子元素交错入场</div>
 * 元素进入视口时添加 in-view 类，触发 CSS 过渡；只触发一次，性能好。
 */
const observer =
  typeof window !== 'undefined' && 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add('in-view');
              observer.unobserve(entry.target);
            }
          }
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
      )
    : null;

export const revealDirective = {
  mounted(el, binding) {
    // 不支持 IO 或用户偏好减效：直接显示
    if (!observer || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('in-view');
      return;
    }
    if (binding.value === 'stagger') {
      el.classList.add('reveal-stagger');
    } else {
      el.classList.add('reveal');
    }
    observer.observe(el);
  },
  unmounted(el) {
    observer?.unobserve(el);
  },
};

export function installReveal(app) {
  app.directive('reveal', revealDirective);
}
