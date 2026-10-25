import { useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, App as AntApp, Button, Form, Input, Select, Space, Table, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { dailyTasksApi, usersApi } from '../../services/api';
import type { UserDTO } from '../../services/api';

const ROLE_OPTIONS = [
  { value: 'OWNER', label: '老板' },
  { value: 'CLERK', label: '内勤' },
  { value: 'REP', label: '业务员' },
  { value: 'WAREHOUSE', label: '仓配' },
];

/**
 * 配置页只接已经存在的接口。
 * 账龄、库存/临期预警在各自页面。押金、抹零上限、提成权重没有写入接口。
 */
export default function SettingsPage(): JSX.Element {
  const { message } = AntApp.useApp();
  const [users, setUsers] = useState<UserDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState('');
  const [running, setRunning] = useState('');

  async function loadUsers(): Promise<void> {
    setLoading(true);
    try {
      setUsers(await usersApi.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载员工失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadUsers(); }, []);

  async function run(name: string, task: () => Promise<unknown>): Promise<void> {
    setRunning(name);
    try {
      const res = await task();
      message.success(`${name}已执行：${JSON.stringify(res).slice(0, 180)}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : `${name}失败`);
    } finally {
      setRunning('');
    }
  }

  return (
    <PageContainer title="配置">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="能改的配置在原页面"
          description={
            <span>
              账龄档位在<Link to="/receivables">应收</Link>，库存与临期预警在<Link to="/stock-alert">库存预警</Link>。
              押金、抹零单笔/月上限、提成权重没有配置接口，这里不能改。
            </span>
          }
        />

        <Typography.Title level={5}>日切任务（老板）</Typography.Title>
        <Space wrap>
          <Input placeholder="期间 YYYY-MM，可空" value={period} onChange={(e) => setPeriod(e.target.value.trim())} style={{ width: 180 }} />
          <Button loading={running === '到期提醒'} onClick={() => { void run('到期提醒', () => dailyTasksApi.reminders()); }}>跑到期提醒</Button>
          <Button loading={running === '月结对账'} onClick={() => { void run('月结对账', () => dailyTasksApi.statements(period || undefined)); }}>跑月结对账</Button>
          <Button loading={running === '自动归档'} onClick={() => { void run('自动归档', () => dailyTasksApi.archive()); }}>跑自动归档</Button>
          <Button loading={running === '开瓶费计提'} onClick={() => { void run('开瓶费计提', () => dailyTasksApi.capAccrue(period || undefined)); }}>跑开瓶费计提</Button>
        </Space>

        <Typography.Title level={5}>员工账号</Typography.Title>
        <Form
          layout="inline"
          onFinish={async (values: { username: string; password: string; name: string; role: UserDTO['role']; phone?: string }) => {
            try {
              await usersApi.create(values);
              message.success('员工已创建');
              void loadUsers();
            } catch (e) {
              message.error(e instanceof Error ? e.message : '创建失败');
            }
          }}
        >
          <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}><Input placeholder="账号" /></Form.Item>
          <Form.Item name="password" rules={[{ required: true, min: 6, message: '至少 6 位' }]}><Input.Password placeholder="密码" /></Form.Item>
          <Form.Item name="name" rules={[{ required: true, message: '请输入姓名' }]}><Input placeholder="姓名" /></Form.Item>
          <Form.Item name="role" rules={[{ required: true, message: '请选择角色' }]}>
            <Select style={{ width: 120 }} placeholder="角色" options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item name="phone"><Input placeholder="手机（选填）" /></Form.Item>
          <Form.Item><Button type="primary" htmlType="submit">创建</Button></Form.Item>
        </Form>
        <Table<UserDTO>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={users}
          pagination={false}
          columns={[
            { title: '账号', dataIndex: 'username' },
            { title: '姓名', dataIndex: 'name' },
            { title: '角色', dataIndex: 'role', width: 120 },
            { title: '状态', dataIndex: 'status', width: 100 },
            {
              title: '操作',
              width: 100,
              render: (_, row) => row.status === 'ACTIVE' ? (
                <a onClick={() => {
                  void usersApi.disable(row.id).then(() => {
                    message.success('已停用');
                    void loadUsers();
                  }).catch((e) => message.error(e instanceof Error ? e.message : '停用失败'));
                }}>停用</a>
              ) : '已停用',
            },
          ]}
        />
      </Space>
    </PageContainer>
  );
}
