/**
 * 可嵌套的 body 滚动锁：抽屉 / TOC / 灯箱可同时持有，
 * 全部释放后才恢复 overflow，避免互相覆盖把页面卡死。
 */
let locks = 0;
let previous = '';

export function lockBodyScroll() {
  if (locks === 0) {
    previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  locks += 1;
}

export function unlockBodyScroll() {
  if (locks === 0) return;
  locks -= 1;
  if (locks === 0) {
    document.body.style.overflow = previous;
    previous = '';
  }
}

export function resetBodyScroll() {
  locks = 0;
  previous = '';
  document.body.style.overflow = '';
}
