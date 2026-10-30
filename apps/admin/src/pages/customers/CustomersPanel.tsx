// 客户档案（P0-T12）。客户管理页和「商品与价格」里的客户页签共用这一份。
import { useEffect, useState } from 'react';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  App as AntApp, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Tag, Typography,
} from 'antd';
import { customersApi, usersApi } from '../../services/api';
import type { CustomerDTO, UserDTO } from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import {
  CUSTOMER_TYPE_LABELS,
  ONBOARDING_META,
  SETTLEMENT_LABELS,
  labelOf,
} from '../../constants/labels';
import { fmtMoney } from '../../utils/format';

export function CustomersPanel({
  prominentCreate = false,
  startCreate = false,
}: {
  prominentCreate?: boolean;
  startCreate?: boolean;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const [q, setQ] = useState('');
  const [onboarding, setOnboarding] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(startCreate);
  const [editing, setEditing] = useState<CustomerDTO | null>(null);
  const [rejecting, setRejecting] = useState<CustomerDTO | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const reload = (): void => setRefreshKey((k) => k + 1);
  const openCreate = (): void => { setEditing(null); setFormOpen(true); };

  async function doOnboarding(c: CustomerDTO, action: 'clerk_confirm' | 'submit_owner' | 'owner_approve'): Promise<void> {
    try {
      await customersApi.onboarding(c.id, action);
      message.success(`已完成：${c.name}`);
      reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    }
  }

  const columns: ProColumns<CustomerDTO>[] = [
    { title: '编码', dataIndex: 'code', width: 100 },
    { title: '店名', dataIndex: 'name', width: 160 },
    { title: '类型', dataIndex: 'type', width: 90, render: (_, r) => labelOf(CUSTOMER_TYPE_LABELS, r.type) },
    { title: '手机', dataIndex: 'phone', width: 120 },
    { title: '结算', dataIndex: 'settlement', width: 80, render: (_, r) => (
      <>
        <Tag>{labelOf(SETTLEMENT_LABELS, r.settlement)}</Tag>
        {r.settlement === 'MONTHLY' && <Typography.Text type="secondary">{r.termsDays}天</Typography.Text>}
      </>
    ) },
    { title: '信用额度', dataIndex: 'creditLimit', width: 110, align: 'right', render: (_, r) => fmtMoney(r.creditLimit) },
    { title: '业务员', width: 100, render: (_, r) => r.salesperson?.name ?? '-' },
    { title: '开户状态', dataIndex: 'onboarding', width: 110, render: (_, r) => {
      const meta = ONBOARDING_META[r.onboarding];
      return <Tag color={meta?.color}>{meta?.label}</Tag>;
    } },
    { title: '档案状态', dataIndex: 'status', width: 90, render: (_, r) => (
      <Tag color={r.status === 'ACTIVE' ? 'success' : 'default'}>{r.status === 'ACTIVE' ? '有效' : '已禁用'}</Tag>
    ) },
    { title: '操作', valueType: 'option', width: 240, render: (_, r) => {
      const canClerk = role === 'clerk' || role === 'owner';
      const btns: JSX.Element[] = [
        <a key="edit" onClick={() => { setEditing(r); setFormOpen(true); }}>编辑</a>,
      ];
      if (role === 'clerk' && r.onboarding === 'REP_DRAFT') {
        btns.push(<a key="cc" onClick={() => doOnboarding(r, 'clerk_confirm')}>内勤确认</a>);
      }
      if (role === 'clerk' && r.onboarding === 'CLERK_CONFIRMED') {
        btns.push(<a key="so" onClick={() => doOnboarding(r, 'submit_owner')}>提交终审</a>);
      }
      if (role === 'owner' && r.onboarding === 'PENDING_OWNER') {
        btns.push(<a key="oa" onClick={() => doOnboarding(r, 'owner_approve')}>终审通过</a>);
      }
      if (canClerk && ['REP_DRAFT', 'CLERK_CONFIRMED', 'PENDING_OWNER'].includes(r.onboarding)) {
        btns.push(<a key="rj" style={{ color: '#cf1322' }} onClick={() => { setRejectReason(''); setRejecting(r); }}>驳回</a>);
      }
      if (canClerk && r.status === 'ACTIVE') {
        btns.push(
          <Popconfirm
            key="dis"
            title="禁用后该客户不可自主下单（纸单回录不受限）"
            onConfirm={async () => {
              try {
                await customersApi.disable(r.id);
                message.success(`已禁用：${r.name}`);
                reload();
              } catch (e) {
                message.error(e instanceof Error ? e.message : '禁用失败');
              }
            }}
          >
            <a style={{ color: '#cf1322' }}>禁用</a>
          </Popconfirm>,
        );
      }
      return <Space size={4} wrap>{btns}</Space>;
    } },
  ];

  return (
    <>
      {prominentCreate && (
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" size="large" style={{ minWidth: 180, fontSize: 16 }} onClick={openCreate}>
            ＋ 新建客户
          </Button>
        </div>
      )}
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          style={{ width: 240 }}
          placeholder="编码 / 店名 / 手机"
          allowClear
          onSearch={(v) => { setQ(v); reload(); }}
        />
        <Select
          style={{ width: 160 }}
          allowClear
          placeholder="开户状态"
          value={onboarding}
          onChange={(v) => { setOnboarding(v); reload(); }}
          options={Object.entries(ONBOARDING_META).map(([value, m]) => ({ value, label: m.label }))}
        />
        {!prominentCreate && (
          <Button type="primary" onClick={openCreate}>新建客户</Button>
        )}
      </Space>
      <ProTable<CustomerDTO>
        rowKey="id"
        search={false}
        options={false}
        params={{ _k: refreshKey }}
        request={async (params) => {
          try {
            const res = await customersApi.list({
              q: q || undefined,
              onboarding,
              page: params.current ?? 1,
              pageSize: params.pageSize ?? 20,
            });
            return { data: res.items ?? [], total: res.total ?? 0, success: true };
          } catch (e) {
            message.error(e instanceof Error ? e.message : '加载客户失败');
            return { data: [], total: 0, success: false };
          }
        }}
        columns={columns}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
      />

      {formOpen ? (
        <CustomerFormModal
          edit={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => { setFormOpen(false); reload(); }}
        />
      ) : null}

      {rejecting ? (
        <Modal
          open
          title={`驳回开户：${rejecting.name}`}
          okText="确认驳回"
          cancelText="关闭"
          onOk={async () => {
            if (!rejectReason.trim()) {
              message.warning('请填写驳回原因');
              return;
            }
            try {
              await customersApi.onboarding(rejecting.id, 'reject', rejectReason.trim());
              message.success('已驳回（审计留痕）');
              setRejecting(null);
              reload();
            } catch (e) {
              message.error(e instanceof Error ? e.message : '驳回失败');
            }
          }}
          onCancel={() => setRejecting(null)}
          destroyOnClose
        >
          <Input.TextArea
            rows={3}
            maxLength={200}
            showCount
            placeholder="请输入驳回原因（商户可见，审计留痕）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </Modal>
      ) : null}
    </>
  );
}

function CustomerFormModal({
  edit, onClose, onSaved,
}: {
  edit: CustomerDTO | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [reps, setReps] = useState<UserDTO[]>([]);

  const settlement = Form.useWatch('settlement', form);

  useEffect(() => {
    form.setFieldsValue(edit ?? { settlement: 'MONTHLY', termsDays: 30, signMode: 'E_SIGN' });
    usersApi.listReps().then(setReps);
  }, [edit, form]);

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    if (values.settlement === 'MONTHLY' && !(values.termsDays > 0)) {
      message.warning('月结客户必须填写账期天数（>0）');
      return;
    }
    setSubmitting(true);
    try {
      if (edit) {
        const { code: _code, ...rest } = values;
        void _code;
        await customersApi.update(edit.id, rest);
        message.success('客户已更新（信用/账期/业务员变更已审计）');
      } else {
        await customersApi.create(values);
        message.success('客户已建档（开户状态=业务员录入，需走四步开户流程）');
      }
      onSaved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      title={edit ? `编辑客户（${edit.code}）` : '新建客户'}
      okText="保存"
      cancelText="取消"
      width={720}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Space wrap size={16}>
          <Form.Item name="code" label="客户编码" rules={[{ required: true, message: '请输入编码' }]}>
            <Input style={{ width: 140 }} disabled={edit !== null} placeholder="C0001" />
          </Form.Item>
          <Form.Item name="name" label="店名" rules={[{ required: true, message: '请输入店名' }]}>
            <Input style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="type" label="客户类型" rules={[{ required: true }]}>
            <Select style={{ width: 130 }} options={Object.entries(CUSTOMER_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="phone" label="手机" rules={[{ required: true, message: '请输入手机' }]}>
            <Input style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="licenseNo" label="证照号"><Input style={{ width: 180 }} placeholder="选填" /></Form.Item>
          <Form.Item name="contact" label="联系人"><Input style={{ width: 120 }} /></Form.Item>
          <Form.Item name="region" label="区域"><Input style={{ width: 120 }} /></Form.Item>
          <Form.Item name="address" label="地址" rules={[{ required: true, message: '请输入地址' }]}>
            <Input style={{ width: 420 }} />
          </Form.Item>
          <Form.Item name="settlement" label="结算方式" rules={[{ required: true }]}>
            <Select style={{ width: 100 }} options={Object.entries(SETTLEMENT_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item
            name="termsDays"
            label="账期天数"
            rules={settlement === 'MONTHLY' ? [{ required: true, message: '月结必填' }] : []}
          >
            <InputNumber min={0} precision={0} style={{ width: 100 }} disabled={settlement === 'CASH'} />
          </Form.Item>
          <Form.Item name="creditLimit" label="信用额度"><InputNumber min={0} style={{ width: 130 }} /></Form.Item>
          <Form.Item name="minOrderAmount" label="起送金额"><InputNumber min={0} style={{ width: 130 }} /></Form.Item>
          <Form.Item name="signMode" label="签收方式">
            <Select style={{ width: 100 }} options={[{ value: 'E_SIGN', label: '网签' }, { value: 'PAPER', label: '纸单' }]} />
          </Form.Item>
          <Form.Item name="receivingWindow" label="收货时段"><Input style={{ width: 140 }} placeholder="周一至周五 8:00-18:00" /></Form.Item>
          <Form.Item name="salespersonId" label="归属业务员">
            <Select
              style={{ width: 160 }}
              allowClear
              showSearch
              optionFilterProp="label"
              options={reps.map((u) => ({ value: u.id, label: u.name }))}
              placeholder="业务员自建自动挂自己"
            />
          </Form.Item>
          <Form.Item name="bossPhone" label="老板手机"><Input style={{ width: 140 }} /></Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}
