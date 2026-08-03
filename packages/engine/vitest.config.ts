import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/data 为规则常量转录表（含少量纯映射函数），豁免覆盖率统计；
      // 其数值由 test/*-data / board / tiles / cards / income 测试直接锚定。
      exclude: ['src/data/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
