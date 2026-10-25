/**
 * 触发一次 Blob 下载。
 *
 * 为什么要有这个工具：项目里原本有 **10 处**各自手写同一段代码
 * （Settings / TagManage / CategoryManage / CommentManage / MessageManage /
 *  LinkManage / ArticleManage / SecurityManage ×2 / AuditManage / ArticleDetail），
 * 每处的临时元素创建、清理与 revoke 写法还不完全一致（有的不 append 到 body、
 * 有的不 remove、变量名 el/a/link 三种）。集中成一个函数才能保证行为一致。
 *
 * 关于 revoke 时机（诚实记录，别把它当既成结论）：
 * 旧代码是 `a.click()` 之后**立即** `URL.revokeObjectURL(url)`。
 * `click()` 只是请求浏览器开始下载，读取是异步的 —— 按规范此时立即释放
 * 会让后续读取落空，Safari / Firefox 上更容易表现为「下载失败」或 0 字节文件。
 * **我没能在本仓库的浏览器自动化环境里复现**（该环境下 blob URL 与页面隔离，
 * 连 10 秒后 revoke 的对照组 fetch 也是 Failed to fetch），
 * 所以这条按规范推理 + 常见故障模式处理，而不是按实测结论。
 * 延迟 revoke 在两种情况下都安全：能读成功就正常下载，读不到也不会更糟。
 *
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 10s 足够慢速设备把 blob 读进下载器；之后释放，不会长期占内存
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
