<template>
  <div class="nf">
    <div class="home-container">
      <div class="nf-card sg-liquid">
        <p class="nf-code">404</p>
        <h1>这里什么也没有</h1>
        <p class="nf-desc">页面可能已被删除，或者链接拼错了。</p>
        <div class="nf-actions">
          <router-link to="/" class="nf-btn primary">回到主页</router-link>
          <router-link to="/notes" class="nf-btn">看看手记</router-link>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nf { padding: 40px 0; }
.nf-card {
  text-align: center;
  padding: 46px 24px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--card-trans);
  box-shadow: var(--shadow-1);
}
.nf-code {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 46px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.04em;
}
.nf-card h1 {
  margin: 8px 0 6px;
  font-size: 20px;
}
.nf-desc {
  margin: 0;
  font-size: 13.5px;
  color: var(--text-3);
}
.nf-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 20px;
}
.nf-btn {
  padding: 9px 18px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text-2);
  font-size: 13.5px;
  text-decoration: none;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.nf-btn:hover { color: var(--accent-deep); border-color: var(--accent); }
.nf-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-contrast);
}
</style>
