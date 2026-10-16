// 费用中心（B组）：费用台账（办公/运营/陈列进店 + 冲抵货款）· 开瓶费政策 · 瓶盖回收 · 月度自动计提
// 流程口径：创建→EXPENSE 审批线（D01 金额路由 ≤阈值出纳可批）→ 付款（CASH）或冲抵货款
// （AR_OFFSET → FEE_OFFSET 应收流水 FIFO，核减未结但不计回款）；开瓶费只能由回收确认/自动计提生成。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  App as AntApp, Button, Card, DatePicker, Descriptions, Form, Input, InputNumber, Modal,
  Radio, Select, Space, Statistic, Switch, Table, Tabs, Tag, Typography,
} from 'antd';
import type { RadioChangeEvent } from 'antd';
import { customersApi, productsApi } from '../../services/api';
import type { CustomerDTO, ProductDTO } from '../../services/api';
import { capFeesApi, expensesApi } from '../../services/expense-api';
import type {
  CapFeePolicyDTO, CapRecycleDTO, CreateExpenseInput, ExpenseCategoryDTO, ExpenseDTO, ExpensePayModeDTO,
} from '../../services/expense-api';
import {
  CAP_RECYCLE_STATUS_META, EXPENSE_CATEGORY_META, EXPENSE_PAY_MODE_LABELS, EXPENSE_STATUS_META,
} from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, recentMonths } from '../../utils/format';

const NEG = '#cf1322';

/** 手工可建科目（开瓶费只能由系统链路生成） */
const MANUAL_CATEGORIES = Object.entries(EXPENSE_CATEGORY_META)
  .filter(([k]) => k !== 'CAP_FEE')
  .map(([value, meta]) => ({ value, label: meta.label, customerLevel: meta.customerLevel }));

function monthStr(m: { format: (f: string) => string } | null): string | undefined {
  return m ? m.format('YYYY-MM') : undefined;
}

export default function ExpensesPage(): JSX.Element {
  return (
    <PageContainer title="费用中心" subTitle="费用台账 · 开瓶费（回/不回瓶盖）· 陈列进店费冲抵货款（B组）">
      <Card>
        <Tabs
          defaultActiveKey="ledger"
          items={[
            { key: 'ledger', label: '费用台账', children: <LedgerTab /> },
            { key: 'policies', label: '开瓶费政策', children: <PolicyTab /> },
            { key: 'recycles', label: '瓶盖回收', children: <RecycleTab /> },
            { key: 'accrual', label: '月度自动计提', children: <AccrualTab /> },
          ]}
        />
      </Card>
    </PageContainer>
  );
}

// ───────────────────────── Tab1 费用台账 ─────────────────────────

function LedgerTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [month, setMonth] = useState<string>(recentMonths(1)[0]);
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<ExpenseDTO[]>([]);
  const [summary, setSummary] = useState<{ byCategory: Record<string, number>; categoryLabels: Record<string, string>; paidTotal: number; pendingTotal: number; offsetTotal: number; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        expensesApi.list({ month, category, status, pageSize: 100 }),
        expensesApi.summary(month),
      ]);
      setRows(list.items);
      setSummary(sum);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载费用台账失败');
    } finally {
      setLoading(false);
    }
  }, [month, category, status, message]);

  useEffect(() => { void load(); }, [load]);

  function payExpense(r: ExpenseDTO): void {
    modal.confirm({
      title: r.payMode === 'AR_OFFSET' ? '执行冲抵货款？' : '确认付款？',
      content: (
        <Descriptions size="small" column={1} bordered style={{ marginTop: 12 }}>
          <Descriptions.Item label="费用单">{r.expenseNo}</Descriptions.Item>
          <Descriptions.Item label="事由">{r.title}</Descriptions.Item>
          <Descriptions.Item label="金额"><span style={{ color: NEG, fontWeight: 600 }}>{fmtMoney(r.amount)}</span></Descriptions.Item>
          {r.customer && <Descriptions.Item label="客户">{r.customer.name}</Descriptions.Item>}
          <Descriptions.Item label="方式">
            {r.payMode === 'AR_OFFSET'
              ? `${EXPENSE_PAY_MODE_LABELS.AR_OFFSET}——按最早到期 FIFO 写 FEE_OFFSET 流水核减该客户未结`
              : EXPENSE_PAY_MODE_LABELS.CASH}
          </Descriptions.Item>
        </Descriptions>
      ),
      okText: r.payMode === 'AR_OFFSET' ? '执行冲抵' : '确认付款',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await expensesApi.pay(r.id, {}) as { mode: string; applied?: Array<{ sourceDocNo: string; amount: number }> };
          message.success(
            res.mode === 'AR_OFFSET'
              ? `已冲抵：${(res.applied ?? []).map((a) => `${a.sourceDocNo} ¥${a.amount.toFixed(2)}`).join('、') || '无'}`
              : '已付款',
          );
          void load();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '操作失败');
        }
      },
    });
  }

  function cancelExpense(r: ExpenseDTO): void {
    let reason = '';
    modal.confirm({
      title: `取消费用单 ${r.expenseNo}`,
      content: (
        <Input.TextArea rows={2} placeholder="取消原因（必填）" onChange={(e) => { reason = e.target.value; }} />
      ),
      okText: '取消单据',
      okButtonProps: { danger: true },
      cancelText: '返回',
      onOk: async () => {
        if (!reason.trim()) { message.warning('请填写取消原因'); return Promise.reject(); }
        try {
          await expensesApi.cancel(r.id, reason.trim());
          message.success('已取消（审批单由状态闸拦截，24h 自然过期）');
          void load();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '取消失败');
        }
      },
    });
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 120 }}
          value={month}
          onChange={setMonth}
          options={recentMonths(12).map((m) => ({ value: m, label: m }))}
        />
        <Select
          style={{ width: 130 }}
          allowClear
          placeholder="全部科目"
          value={category}
          onChange={setCategory}
          options={MANUAL_CATEGORIES.concat([{ value: 'CAP_FEE', label: '开瓶费', customerLevel: true }]).map((c) => ({ value: c.value, label: c.label }))}
        />
        <Select
          style={{ width: 120 }}
          allowClear
          placeholder="全部状态"
          value={status}
          onChange={setStatus}
          options={Object.entries(EXPENSE_STATUS_META).map(([value, m]) => ({ value, label: m.label }))}
        />
        <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateOpen(true)}>新建费用</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          客户级科目（陈列/进店/开瓶费）可选「冲抵货款」；审批走费用线（≤阈值出纳可批）
        </Typography.Text>
      </Space>

      <Space style={{ marginBottom: 16 }} wrap>
        <Statistic title="当月费用合计" value={fmtMoney(summary?.total)} />
        <Statistic title="已付/已冲抵" value={fmtMoney(summary?.paidTotal)} valueStyle={{ color: '#389e0d' }} />
        <Statistic title="待付(审批中+已批)" value={fmtMoney(summary?.pendingTotal)} valueStyle={{ color: '#fa8c16' }} />
        <Statistic title="其中冲抵货款" value={fmtMoney(summary?.offsetTotal)} valueStyle={{ color: '#2f6db5' }} />
      </Space>
      {summary && Object.keys(summary.byCategory).length > 0 && (
        <Space style={{ marginBottom: 16 }} wrap size={4}>
          {Object.entries(summary.byCategory).map(([k, v]) => (
            <Tag key={k} color={EXPENSE_CATEGORY_META[k]?.color}>
              {summary.categoryLabels[k] ?? k} {fmtMoney(v)}
            </Tag>
          ))}
        </Space>
      )}

      <Table<ExpenseDTO>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: '该月份暂无费用单' }}
        columns={[
          { title: '单号', dataIndex: 'expenseNo', width: 150, render: (v: string) => <Typography.Text copyable>{v}</Typography.Text> },
          { title: '科目', dataIndex: 'category', width: 100, render: (v: ExpenseCategoryDTO) => <Tag color={EXPENSE_CATEGORY_META[v]?.color}>{EXPENSE_CATEGORY_META[v]?.label ?? v}</Tag> },
          { title: '事由', dataIndex: 'title', ellipsis: true },
          { title: '客户', width: 130, render: (_, r) => r.customer?.name ?? <Typography.Text type="secondary">{r.payee ?? '—'}</Typography.Text> },
          { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v: number) => <b>{fmtMoney(v)}</b> },
          { title: '方式', dataIndex: 'payMode', width: 100, render: (v: ExpensePayModeDTO) => EXPENSE_PAY_MODE_LABELS[v] },
          { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <Tag color={EXPENSE_STATUS_META[v]?.color}>{EXPENSE_STATUS_META[v]?.label ?? v}</Tag> },
          { title: '发生日', dataIndex: 'occurredAt', width: 100, render: (v: string) => fmtDate(v) },
          { title: '付款/冲抵时间', dataIndex: 'paidAt', width: 140, render: (v: string | null) => (v ? fmtDateTime(v) : '—') },
          {
            title: '操作', width: 150,
            render: (_, r) => (
              <Space size={4}>
                {r.status === 'APPROVED' && <a onClick={() => payExpense(r)}>{r.payMode === 'AR_OFFSET' ? '执行冲抵' : '付款'}</a>}
                {r.status === 'PENDING_APPROVAL' && (
                  <>
                    <Typography.Text type="secondary">待审批</Typography.Text>
                    <a onClick={() => cancelExpense(r)}>取消</a>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      <CreateExpenseModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); void load(); }}
      />
    </div>
  );
}

// ───────────────────────── 新建费用 ─────────────────────────

function CreateExpenseModal({
  open, onClose, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [category, setCategory] = useState<string>('OFFICE');
  const [payMode, setPayMode] = useState<ExpensePayModeDTO>('CASH');
  const [submitting, setSubmitting] = useState(false);
  const customerLevel = MANUAL_CATEGORIES.find((c) => c.value === category)?.customerLevel ?? false;

  useEffect(() => {
    if (open) {
      form.resetFields();
      setCategory('OFFICE');
      setPayMode('CASH');
      customersApi.list({ page: 1, pageSize: 200 }).then((r) => setCustomers(r.items)).catch(() => setCustomers([]));
    }
  }, [open, form]);

  async function submit(): Promise<void> {
    const v = await form.validateFields();
    setSubmitting(true);
    try {
      const input: CreateExpenseInput = {
        category: v.category,
        title: v.title.trim(),
        amount: v.amount,
        customerId: v.customerId,
        payee: v.payee?.trim() || undefined,
        occurredAt: v.occurredAt ? v.occurredAt.format('YYYY-MM-DD') : undefined,
        payMode: v.payMode,
        note: v.note?.trim() || undefined,
      };
      await expensesApi.create(input);
      message.success('费用单已创建并提交审批（≤阈值出纳可批）');
      onSaved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建费用单"
      okText="提交审批"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical" initialValues={{ category: 'OFFICE', payMode: 'CASH' }}>
        <Form.Item name="category" label="科目" rules={[{ required: true }]}>
          <Select
            options={MANUAL_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
            onChange={(v) => setCategory(v)}
          />
        </Form.Item>
        <Form.Item name="title" label="事由" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="如：10月办公用品采购 / 王五超市进场陈列费" />
        </Form.Item>
        <Form.Item name="amount" label="金额（元）" rules={[{ required: true, message: '必填' }]}>
          <InputNumber min={0.01} precision={2} style={{ width: 200 }} prefix="¥" />
        </Form.Item>
        {customerLevel && (
          <Form.Item name="customerId" label="客户（客户级费用必选）" rules={[{ required: true, message: '陈列/进店费必须关联客户' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择客户"
              options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
            />
          </Form.Item>
        )}
        {!customerLevel && (
          <Form.Item name="payee" label="收款方（供应商/加油站/物业等）">
            <Input placeholder="选填" />
          </Form.Item>
        )}
        <Form.Item name="occurredAt" label="费用发生日">
          <DatePicker style={{ width: 200 }} />
        </Form.Item>
        <Form.Item name="payMode" label="支付方式">
          <Radio.Group
            onChange={(e: RadioChangeEvent) => setPayMode(e.target.value)}
          >
            <Radio.Button value="CASH">现金/转账</Radio.Button>
            <Radio.Button value="AR_OFFSET" disabled={!customerLevel}>冲抵货款</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {payMode === 'AR_OFFSET' && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            审批通过后执行冲抵：按最早到期 FIFO 写费用冲抵流水核减该客户未结（不计回款口径）。
          </Typography.Paragraph>
        )}
        <Form.Item name="note" label="备注（审批理由默认取此项）">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ───────────────────────── Tab2 开瓶费政策 ─────────────────────────

function PolicyTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState<CapFeePolicyDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [form] = Form.useForm();

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setRows((await capFeesApi.policies()) as CapFeePolicyDTO[]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载开瓶费政策失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (editOpen) {
      productsApi.list({ page: 1, pageSize: 200 }).then((r) => setProducts(r.items)).catch(() => setProducts([]));
    }
  }, [editOpen]);

  async function save(): Promise<void> {
    const v = await form.validateFields();
    try {
      await capFeesApi.savePolicy({
        productId: v.productId,
        perBottleFee: v.perBottleFee,
        requireCap: v.requireCap,
        noCapRate: v.requireCap ? undefined : v.noCapRate,
      });
      message.success('政策已保存（回收模式即时生效；自动计提每月 1 日跑上月）');
      setEditOpen(false);
      void load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); form.setFieldsValue({ requireCap: true, noCapRate: 1 }); setEditOpen(true); }}>配置商品政策</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          回瓶盖：按回收单数量全额兑付（需登记回收）；不回瓶盖：按月自动计提 瓶数×每瓶费×兑付比例（Q3 比例可配，默认全额）
        </Typography.Text>
      </Space>
      <Table<CapFeePolicyDTO>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: '暂无生效中的开瓶费政策' }}
        columns={[
          { title: '商品', render: (_, r) => `${r.productName}（${r.skuCode}）` },
          { title: '每瓶开瓶费', dataIndex: 'perBottleFee', width: 110, align: 'right', render: (v: number) => fmtMoney(v) },
          {
            title: '模式', dataIndex: 'requireCap', width: 120,
            render: (v: boolean) => (v ? <Tag color="green">回瓶盖兑付</Tag> : <Tag color="purple">不回瓶盖·自动计提</Tag>),
          },
          { title: '兑付比例(不回盖)', dataIndex: 'noCapRate', width: 120, align: 'right', render: (v: number) => `${Math.round(v * 100)}%` },
          { title: '生效自', dataIndex: 'validFrom', width: 100, render: (v: string) => fmtDate(v) },
          {
            title: '操作', width: 80,
            render: (_, r) => (
              <a onClick={() => modal.confirm({
                title: `关闭 ${r.productName} 的开瓶费政策？`,
                content: '关闭后不再计提/不可回收登记；已生成费用单不受影响。',
                okText: '关闭政策',
                okButtonProps: { danger: true },
                onOk: async () => {
                  try { await capFeesApi.closePolicy(r.id); message.success('已关闭'); void load(); }
                  catch (e) { message.error(e instanceof Error ? e.message : '操作失败'); }
                },
              })}>关闭</a>
            ),
          },
        ]}
      />

      <Modal
        open={editOpen}
        title="配置开瓶费政策（商品级）"
        okText="保存"
        cancelText="取消"
        onOk={save}
        onCancel={() => setEditOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="productId" label="商品" rules={[{ required: true, message: '必选' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择商品"
              options={products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))}
            />
          </Form.Item>
          <Form.Item name="perBottleFee" label="每瓶开瓶费（元）" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={0.01} precision={2} style={{ width: 200 }} prefix="¥" placeholder="如 0.5" />
          </Form.Item>
          <Form.Item name="requireCap" label="模式" valuePropName="checked">
            <Switch checkedChildren="回瓶盖兑付" unCheckedChildren="不回瓶盖·自动计提" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.requireCap !== b.requireCap}>
            {({ getFieldValue }) => !getFieldValue('requireCap') ? (
              <Form.Item name="noCapRate" label="不回盖兑付比例（Q3：不回瓶盖系统自动扣减多少）" rules={[{ required: true }]}>
                <InputNumber min={0.01} max={1} step={0.1} precision={2} style={{ width: 200 }} addonAfter="×比例" />
              </Form.Item>
            ) : null}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ───────────────────────── Tab3 瓶盖回收 ─────────────────────────

function RecycleTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState<CapRecycleDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('PENDING_CONFIRM');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await capFeesApi.recycles({ status: status || undefined, pageSize: 100 });
      setRows(res.items as CapRecycleDTO[]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载回收单失败');
    } finally {
      setLoading(false);
    }
  }, [status, message]);

  useEffect(() => { void load(); }, [load]);

  function confirm(r: CapRecycleDTO): void {
    let payMode: ExpensePayModeDTO = 'AR_OFFSET';
    modal.confirm({
      title: `确认兑付 ${r.recycleNo}`,
      content: (
        <Space direction="vertical" style={{ marginTop: 12 }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="客户">{r.customer.name}</Descriptions.Item>
            <Descriptions.Item label="明细">
              {r.lines.map((l) => `${l.productName}×${l.qty}个 × ¥${l.perBottleFee}`).join('；')}
            </Descriptions.Item>
            <Descriptions.Item label="兑付金额"><b style={{ color: NEG }}>{fmtMoney(r.totalAmount)}</b></Descriptions.Item>
          </Descriptions>
          <Radio.Group defaultValue={payMode} onChange={(e: RadioChangeEvent) => { payMode = e.target.value; }}>
            <Radio.Button value="AR_OFFSET">冲抵货款（进费用审批）</Radio.Button>
            <Radio.Button value="CASH">现金兑付（进费用审批）</Radio.Button>
          </Radio.Group>
        </Space>
      ),
      okText: '生成费用单',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await capFeesApi.confirmRecycle(r.id, { payMode }) as { expenseNo: string };
          message.success(`已生成开瓶费费用单 ${res.expenseNo}（待审批）`);
          void load();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '确认失败');
        }
      },
    });
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ width: 140 }}
          value={status}
          onChange={setStatus}
          options={[{ value: '', label: '全部' }, ...Object.entries(CAP_RECYCLE_STATUS_META).map(([value, m]) => ({ value, label: m.label }))]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          业务员在小程序「瓶盖回收」登记 → 此处确认兑付（生成开瓶费费用单进审批）→ 审批通过后付款/冲抵
        </Typography.Text>
      </Space>
      <Table<CapRecycleDTO>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: '暂无回收单（业务员端小程序可登记）' }}
        columns={[
          { title: '单号', dataIndex: 'recycleNo', width: 150, render: (v: string) => <Typography.Text copyable>{v}</Typography.Text> },
          { title: '客户', render: (_, r) => r.customer.name },
          { title: '回收明细', ellipsis: true, render: (_, r) => r.lines.map((l) => `${l.productName}×${l.qty}`).join('；') },
          { title: '兑付金额', dataIndex: 'totalAmount', width: 110, align: 'right', render: (v: number) => <b>{fmtMoney(v)}</b> },
          { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <Tag color={CAP_RECYCLE_STATUS_META[v]?.color}>{CAP_RECYCLE_STATUS_META[v]?.label ?? v}</Tag> },
          { title: '登记时间', dataIndex: 'createdAt', width: 150, render: (v: string) => fmtDateTime(v) },
          {
            title: '操作', width: 90,
            render: (_, r) => r.status === 'PENDING_CONFIRM' ? (
              <Space size={4}>
                <a onClick={() => confirm(r)}>确认兑付</a>
                <a style={{ color: NEG }} onClick={() => {
                  let reason = '';
                  modal.confirm({
                    title: `取消 ${r.recycleNo}`,
                    content: <Input.TextArea rows={2} placeholder="取消原因（必填）" onChange={(e) => { reason = e.target.value; }} />,
                    okText: '取消单据',
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      if (!reason.trim()) { message.warning('请填写原因'); return Promise.reject(); }
                      try { await capFeesApi.cancelRecycle(r.id, reason.trim()); message.success('已取消'); void load(); }
                      catch (e2) { message.error(e2 instanceof Error ? e2.message : '操作失败'); }
                    },
                  });
                }}>取消</a>
              </Space>
            ) : '—',
          },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Tab4 月度自动计提 ─────────────────────────

function AccrualTab(): JSX.Element {
  const { message } = AntApp.useApp();
  const [period, setPeriod] = useState<string>(recentMonths(2)[1] ?? recentMonths(1)[0]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ period: string; customers: number; expenses: number; totalAmount: number; skipped: number } | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    try {
      const res = await capFeesApi.accrue(period);
      setResult(res);
      message.success(`计提完成：${res.expenses} 张费用单 / ¥${res.totalAmount.toFixed(2)}${res.skipped ? `（${res.skipped} 客户已有跳过）` : ''}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '计提失败');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card style={{ maxWidth: 640 }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          对「不回瓶盖」政策商品，按所选账期内<b>签收订单的瓶数</b>×每瓶开瓶费×兑付比例自动生成开瓶费费用单（系统直入已批状态、默认冲抵货款，出纳在费用台账执行冲抵）。
          每月 1 日随日切任务自动跑上月；此处可手动补跑任意账期（同客户同账期幂等跳过）。
        </Typography.Paragraph>
        <Space wrap>
          <Select
            style={{ width: 130 }}
            value={period}
            onChange={setPeriod}
            options={recentMonths(6).map((m) => ({ value: m, label: m }))}
          />
          <Button type="primary" icon={<ThunderboltOutlined />} loading={running} onClick={() => { void run(); }}>
            执行计提
          </Button>
        </Space>
        {result && (
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="账期">{result.period}</Descriptions.Item>
            <Descriptions.Item label="覆盖客户">{result.customers}</Descriptions.Item>
            <Descriptions.Item label="生成费用单">{result.expenses}</Descriptions.Item>
            <Descriptions.Item label="计提总额"><b style={{ color: NEG }}>{fmtMoney(result.totalAmount)}</b></Descriptions.Item>
            <Descriptions.Item label="幂等跳过">{result.skipped}</Descriptions.Item>
          </Descriptions>
        )}
      </Space>
    </Card>
  );
}
