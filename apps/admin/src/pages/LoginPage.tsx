import { Button, Alert, Typography, App as AntApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { login, saveAuth } from '../services/auth';

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';
const fieldStyle: CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box', marginBottom: 16,
  height: 40, padding: '0 12px', border: '1px solid #d9d9d9', borderRadius: 6, fontSize: 16,
};

export default function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [denied] = useState(() => {
    const text = sessionStorage.getItem('ld_admin_denied');
    if (text) sessionStorage.removeItem('ld_admin_denied');
    return text;
  });

  const onFinish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    const tenantCode = String(form.get('tenantCode') ?? '');
    if (!username || !password) {
      message.error('请输入账号和密码');
      return;
    }
    setLoading(true);
    try {
      const user = await login(username, password, tenantCode);
      saveAuth(user);
      message.success(`欢迎，${user.name}`);
      navigate('/', { replace: true });
    } catch (e) {
      message.error(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', background: '#f0f2f5',
      }}
    >
      <div style={{ width: 380, background: '#fff', borderRadius: 8, padding: 24, boxShadow: '0 6px 16px rgba(0,0,0,.08)' }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>酒类分销订货商城 · 内勤后台登录</Typography.Title>
        {denied && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={denied} />}
        {USE_MOCK && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="当前为 mock 登录（仅 VITE_USE_MOCK=true 时启用）"
            description="请输入已配置的 mock 账号，页面不再预填"
          />
        )}
        <form onSubmit={onFinish}>
          <input name="tenantCode" placeholder="租户编码（同名账号时必填）" style={fieldStyle} />
          <input name="username" placeholder="账号" autoComplete="username" style={fieldStyle} />
          <input name="password" type="password" placeholder="密码" autoComplete="current-password" style={fieldStyle} />
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            登 录
          </Button>
        </form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          登录即代表同意按角色访问对应数据范围（P0-02 租户隔离）
        </Typography.Text>
      </div>
    </div>
  );
}
