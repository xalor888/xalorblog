<template>
  <el-config-provider :locale="zhCn" :message="messageConfig">
    <RouteProgress />
    <router-view v-slot="{ Component }">
      <transition name="page-fade" mode="out-in">
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
