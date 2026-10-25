import { Card, Form, Input, Button, Alert, Typography, App as AntApp } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { login, saveAuth } from '../services/auth';

const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

export default function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string; tenantCode?: string }) => {
    setLoading(true);
    try {
      const user = await login(values.username, values.password, values.tenantCode);
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
      <Card title="酒类分销订货商城 · 内勤后台登录" style={{ width: 380 }}>
        {USE_MOCK && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="当前为 mock 登录（VITE_USE_MOCK=false 切真接口）"
            description="账户: owner / rep / clerk / warehouse / customer，密码均为 123456"
          />
        )}
        <Form onFinish={onFinish} initialValues={{ username: 'clerk', password: '123456' }}>
          <Form.Item name="tenantCode">
            <Input placeholder="租户编码（同名账号时必填）" size="large" />
          </Form.Item>
          <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="账号" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          登录即代表同意按角色访问对应数据范围（P0-02 租户隔离）
        </Typography.Text>
      </Card>
    </div>
  );
}
