<template>
  <el-config-provider :locale="zhCn" :message="messageConfig">
    <RouteProgress />
    <router-view v-slot="{ Component }">
      <!-- 显式 duration：结束时机走固定 setTimeout，不依赖 transitionend/帧回调。
           后台标签页/被遮挡窗口渲染帧冻结时，帧检测过渡会无限搁浅，
           表现为路由已就位但页面停留在旧视图（冷加载详情路由显示首页）。 -->
      <transition name="page-fade" mode="out-in" :duration="{ enter: 220, leave: 200 }">
        <component :is="Component" />
      </transition>
    </router-view>
  </el-config-provider>
</template>

<script setup>
import { onMounted } from 'vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import RouteProgress from '@/components/ui/RouteProgress.vue';
import { initMarkdownInteractions } from '@/utils/markdown';

const messageConfig = { placement: 'top-right', offset: 72, grouping: true };

onMounted(() => {
  // 全局 Markdown 交互（代码复制）——事件委托，只初始化一次
  initMarkdownInteractions();
});
</script>
