import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import App from './App';
import { installGlobalTelemetry } from './services/telemetry';

// 全局错误遥测兜底（unhandled rejection / window error → POST /telemetry/events）
installGlobalTelemetry();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff' } }}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </BrowserRouter>,
);
