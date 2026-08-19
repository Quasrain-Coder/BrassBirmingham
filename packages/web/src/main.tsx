import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// 工业时代主题字体（OFL，woff2 自托管，离线可用）：
// Yeseva One 维多利亚衬线（标题）+ Special Elite 打字机（日志/标签）
import '@fontsource/yeseva-one/400.css';
import '@fontsource/special-elite/400.css';
import './style.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html 缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
