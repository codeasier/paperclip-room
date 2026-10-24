import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RoomApp } from './app/RoomApp';
import 'antd/dist/reset.css';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 3000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        componentSize="small"
        button={{ autoInsertSpace: false }}
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: '#c65213',
            colorText: '#242b36',
            colorTextSecondary: '#737d8c',
            colorBorder: '#dfe3e9',
            colorBgLayout: '#f8f9fb',
            colorBgMask: 'rgba(31, 35, 40, 0.4)',
            borderRadius: 8,
            fontSize: 13,
            controlHeight: 32,
            controlHeightSM: 28,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          },
        }}
      >
        <AntApp>
          <RoomApp />
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
