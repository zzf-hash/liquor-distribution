import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff' } }}>
    <AntApp>
      <App />
    </AntApp>
  </ConfigProvider>,
);
