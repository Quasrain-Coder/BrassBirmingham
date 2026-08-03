import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest globals 关闭时 testing-library 不会自动 cleanup，显式注册避免跨用例 DOM 泄漏。
afterEach(cleanup);
