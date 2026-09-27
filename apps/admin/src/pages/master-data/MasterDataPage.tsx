// 主数据（P0-T10~T13）：商品档案 / 客户档案+开户四步 / 五级价+一客一价 / 数据导入（预览差异报告→提交/回滚）
import { useEffect, useState } from 'react';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Button, Card, Descriptions, Form, Input, InputNumber, Modal,
  Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import {
  customersApi,
  importsApi,
  pricesApi,
  productsApi,
  usersApi,
} from '../../services/api';
import type {
  CustomerDTO,
  CustomerPriceVersionDTO,
  ImportKindDTO,
  ImportPreviewDTO,
  ImportRowIssueDTO,
  PriceVersionDTO,
  ProductDTO,
  UserDTO,
} from '../../services/api';
import { getAuth } from '../../services/auth';
import type { Role } from '../../constants/roles';
import {
  CUSTOMER_TYPE_LABELS,
  IMPORT_KIND_OPTIONS,
  IMPORT_LEVEL_META,
  ONBOARDING_META,
  PRICE_LEVEL_LABELS,
  PRICE_UNIT_LABELS,
  PRODUCT_CATEGORY_LABELS,
  PRODUCT_STATUS_META,
  SETTLEMENT_LABELS,
  labelOf,
} from '../../constants/labels';
import { fmtDate, fmtMoney } from '../../utils/format';

export default function MasterDataPage(): JSX.Element {
  return (
    <PageContainer title="主数据" subTitle="商品档案 · 客户档案 · 五级价 · 数据导入（P0-T10~T13）">
      <Card>
        <Tabs
          defaultActiveKey="products"
          items={[
            { key: 'products', label: '商品', children: <ProductsTab /> },
            { key: 'customers', label: '客户', children: <CustomersTab /> },
            { key: 'prices', label: '价格', children: <PriceTab /> },
            { key: 'imports', label: '数据导入', children: <ImportTab /> },
          ]}
        />
      </Card>
    </PageContainer>
  );
}

// ═══════════════════════ 商品（P0-T10） ═══════════════════════

function ProductsTab(): JSX.Element {
  const { message } = AntApp.useApp();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductDTO | null>(null);

  const columns: ProColumns<ProductDTO>[] = [
    { title: '编码', dataIndex: 'skuCode', width: 110 },
    { title: '名称', dataIndex: 'name', width: 170, render: (_, r) => (
      <Space size={4}>
        <span>{r.name}</span>
        {r.highValue && <Tag color="volcano">高值</Tag>}
      </Space>
    ) },
    { title: '品类', dataIndex: 'category', width: 80, render: (_, r) => labelOf(PRODUCT_CATEGORY_LABELS, r.category) },
    { title: '规格', dataIndex: 'specText', width: 120, render: (_, r) => r.specText ?? '-' },
    {
      title: '整散换算', width: 130,
      render: (_, r) => `1${r.baseUnit}=${r.packSize}${r.minUnit}`,
    },
    { title: '条码', dataIndex: 'barcode', width: 130, render: (_, r) => r.barcode ?? '-' },
    {
      title: '现价概要', width: 200,
      render: (_, r) => (
        <Space size={4} wrap>
          {(r.priceSummary ?? []).slice(0, 3).map((s, i) => (
            <Tag key={i}>{labelOf(PRICE_LEVEL_LABELS, s.levelType)} {fmtMoney(s.price)}</Tag>
          ))}
          {(r.priceSummary ?? []).length === 0 && <Typography.Text type="secondary">未配价</Typography.Text>}
        </Space>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 80, render: (_, r) => {
      const meta = PRODUCT_STATUS_META[r.status];
      return <Tag color={meta?.color}>{meta?.label}</Tag>;
    } },
    { title: '操作', valueType: 'option', width: 120, render: (_, r) => (
      <Space size={4}>
        <a onClick={() => { setEditing(r); setFormOpen(true); }}>编辑</a>
        {r.status === 'ON_SALE' && (
          <Popconfirm
            title="停售后不可再下单，历史单据不受影响"
            onConfirm={async () => {
              try {
                await productsApi.disable(r.id);
                message.success(`已停售：${r.name}`);
                setRefreshKey((k) => k + 1);
              } catch (e) {
                message.error(e instanceof Error ? e.message : '停售失败');
              }
            }}
          >
            <a style={{ color: '#cf1322' }}>停售</a>
          </Popconfirm>
        )}
      </Space>
    ) },
  ];

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          style={{ width: 240 }}
          placeholder="名称 / 首字 / 编码 / 条码"
          allowClear
          onSearch={(v) => { setQ(v); setRefreshKey((k) => k + 1); }}
        />
        <Select
          style={{ width: 110 }}
          allowClear
          placeholder="品类"
          value={category}
          onChange={(v) => { setCategory(v); setRefreshKey((k) => k + 1); }}
          options={Object.entries(PRODUCT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <Select
          style={{ width: 100 }}
          allowClear
          placeholder="状态"
          value={status}
          onChange={(v) => { setStatus(v); setRefreshKey((k) => k + 1); }}
          options={Object.entries(PRODUCT_STATUS_META).map(([value, m]) => ({ value, label: m.label }))}
        />
        <Button type="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>新建商品</Button>
      </Space>
      <ProTable<ProductDTO>
        rowKey="id"
        search={false}
        options={false}
        params={{ _k: refreshKey }}
        request={async (params) => {
          try {
            const res = await productsApi.list({
              q: q || undefined,
              category,
              status,
              page: params.current ?? 1,
              pageSize: params.pageSize ?? 20,
            });
            return { data: res.items, total: res.total, success: true };
          } catch (e) {
            message.error(e instanceof Error ? e.message : '加载商品失败');
            return { data: [], total: 0, success: false };
          }
        }}
        columns={columns}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
      />
      <ProductFormModal
        open={formOpen}
        edit={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); setRefreshKey((k) => k + 1); }}
      />
    </>
  );
}

function ProductFormModal({
  open, edit, onClose, onSaved,
}: {
  open: boolean;
  edit: ProductDTO | null;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(
        edit ?? { baseUnit: '箱', minUnit: '瓶', packSize: 6, category: 'BAIJIU', highValue: false },
      );
    }
  }, [open, edit, form]);

  async function submit(): Promise<void> {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (edit) {
        // 编码禁改：更新载荷不含 skuCode
        const { skuCode: _skuCode, ...rest } = values;
        void _skuCode;
        await productsApi.update(edit.id, rest);
        message.success('商品已更新（审计留痕）');
      } else {
        await productsApi.create(values);
        message.success('商品已建档');
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
      open={open}
      title={edit ? `编辑商品（${edit.skuCode}）` : '新建商品'}
      okText="保存"
      cancelText="取消"
      width={680}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Space wrap size={16}>
          <Form.Item name="skuCode" label="商品编码" rules={[{ required: true, message: '请输入编码' }]}>
            <Input style={{ width: 160 }} disabled={edit !== null} placeholder="沿用商户现用编码" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="category" label="品类" rules={[{ required: true }]}>
            <Select style={{ width: 120 }} options={Object.entries(PRODUCT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="brand" label="品牌"><Input style={{ width: 160 }} /></Form.Item>
          <Form.Item name="baseUnit" label="主单位" rules={[{ required: true }]}><Input style={{ width: 100 }} placeholder="箱" /></Form.Item>
          <Form.Item name="minUnit" label="最小单位" rules={[{ required: true }]}><Input style={{ width: 100 }} placeholder="瓶" /></Form.Item>
          <Form.Item name="packSize" label="换算率(1主=N最小)" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} precision={0} style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="barcode" label="条码"><Input style={{ width: 180 }} /></Form.Item>
          <Form.Item name="abv" label="度数"><InputNumber min={0} max={100} style={{ width: 100 }} /></Form.Item>
          <Form.Item name="origin" label="产地"><Input style={{ width: 140 }} /></Form.Item>
          <Form.Item name="supplier" label="供应商"><Input style={{ width: 160 }} /></Form.Item>
          <Form.Item name="specText" label="规格描述"><Input style={{ width: 160 }} placeholder="500ml×6" /></Form.Item>
          <Form.Item name="pinyinFirst" label="首字检索"><Input style={{ width: 120 }} placeholder="WLY" /></Form.Item>
          <Form.Item name="highValue" label="高值品（防盗调包）" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  );
}

// ═══════════════════════ 客户（P0-T12） ═══════════════════════

function CustomersTab(): JSX.Element {
  const { message } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'owner';
  const [q, setQ] = useState('');
  const [onboarding, setOnboarding] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomerDTO | null>(null);
  const [rejecting, setRejecting] = useState<CustomerDTO | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const reload = (): void => setRefreshKey((k) => k + 1);

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
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          style={{ width: 240 }}
          placeholder="编码 / 店名 / 手机"
          allowClear
          onSearch={(v) => { setQ(v); reload(); }}
        />
        <Select
          style={{ width: 140 }}
          allowClear
          placeholder="开户状态"
          value={onboarding}
          onChange={(v) => { setOnboarding(v); reload(); }}
          options={Object.entries(ONBOARDING_META).map(([value, m]) => ({ value, label: m.label }))}
        />
        <Button type="primary" onClick={() => { setEditing(null); setFormOpen(true); }}>新建客户</Button>
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
            return { data: res.items, total: res.total, success: true };
          } catch (e) {
            message.error(e instanceof Error ? e.message : '加载客户失败');
            return { data: [], total: 0, success: false };
          }
        }}
        columns={columns}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
      />

      <CustomerFormModal
        open={formOpen}
        edit={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); reload(); }}
      />

      <Modal
        open={rejecting !== null}
        title={rejecting ? `驳回开户：${rejecting.name}` : ''}
        okText="确认驳回"
        cancelText="关闭"
        onOk={async () => {
          if (!rejecting) return;
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
    </>
  );
}

function CustomerFormModal({
  open, edit, onClose, onSaved,
}: {
  open: boolean;
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
    if (open) {
      form.resetFields();
      form.setFieldsValue(
        edit ?? { settlement: 'MONTHLY', termsDays: 30, signMode: 'E_SIGN' },
      );
      usersApi.listReps().then(setReps);
    }
  }, [open, edit, form]);

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
      open={open}
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

// ═══════════════════════ 价格（P0-T11） ═══════════════════════

const UNIT_OPTIONS = Object.entries(PRICE_UNIT_LABELS).map(([value, label]) => ({ value, label }));
const LEVEL_OPTIONS = Object.entries(PRICE_LEVEL_LABELS)
  .filter(([v]) => v !== 'CUSTOMER_EXCLUSIVE')
  .map(([value, label]) => ({ value, label }));

function PriceTab(): JSX.Element {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <ProductPriceCard />
      <CustomerPriceCard />
    </Space>
  );
}

function ProductPriceCard(): JSX.Element {
  const { message } = AntApp.useApp();
  const role: Role = getAuth()?.role ?? 'clerk';
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [productId, setProductId] = useState<string>();
  const [rows, setRows] = useState<PriceVersionDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    productsApi.list({ page: 1, pageSize: 200 })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    if (!productId) { setRows([]); return; }
    setLoading(true);
    pricesApi.listForProduct(productId)
      .then(setRows)
      .catch((e) => { setRows([]); message.error(e instanceof Error ? e.message : '加载价格失败'); })
      .finally(() => setLoading(false));
  }, [productId, message]);

  return (
    <Card size="small" title="商品五级价（成本→一批→二批→终端→零售，版本化只新增不覆盖）">
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          style={{ width: 300 }}
          showSearch
          optionFilterProp="label"
          placeholder="选择商品查看价格版本"
          value={productId}
          onChange={setProductId}
          options={products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))}
        />
        <Button type="primary" disabled={!productId} onClick={() => setCreateOpen(true)}>新增价格版本</Button>
        {role !== 'owner' && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>成本价仅老板可见/可维护</Typography.Text>
        )}
      </Space>
      <Table<PriceVersionDTO>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: productId ? '暂无价格版本' : '请先选择商品' }}
        columns={[
          { title: '计价单位', dataIndex: 'unit', width: 120, render: (v: string) => labelOf(PRICE_UNIT_LABELS, v) },
          { title: '价格级别', dataIndex: 'levelType', width: 120, render: (v: string) => labelOf(PRICE_LEVEL_LABELS, v) },
          { title: '价格', dataIndex: 'price', width: 110, align: 'right' as const, render: (v: PriceVersionDTO['price']) => fmtMoney(v) },
          { title: '生效日', dataIndex: 'validFrom', width: 110, render: (v: string) => fmtDate(v) },
          { title: '失效日', dataIndex: 'validTo', width: 110, render: (v: string | null) => (v ? fmtDate(v) : '长期') },
          { title: '审批单号', dataIndex: 'approvalRef', width: 130, render: (v: string | null) => v ?? '-' },
          { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string | null) => v ?? '-' },
        ]}
      />
      <PriceVersionModal
        open={createOpen}
        title="新增价格版本"
        showLevel
        onClose={() => setCreateOpen(false)}
        onSubmit={async (input) => {
          if (productId) await pricesApi.createForProduct(productId, input);
        }}
        onDone={() => { setCreateOpen(false); if (productId) pricesApi.listForProduct(productId).then(setRows); }}
      />
    </Card>
  );
}

function CustomerPriceCard(): JSX.Element {
  const { message } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [customerId, setCustomerId] = useState<string>();
  const [rows, setRows] = useState<CustomerPriceVersionDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const load = (cid: string): void => {
    setLoading(true);
    pricesApi.listForCustomer(cid)
      .then(setRows)
      .catch((e) => { setRows([]); message.error(e instanceof Error ? e.message : '加载专属价失败'); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    customersApi.list({ page: 1, pageSize: 200 })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    if (customerId) load(customerId);
    else setRows([]);
  }, [customerId]);

  return (
    <Card size="small" title="客户专属价（一客一价，版本化；无审批单号记警告不阻断）">
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          style={{ width: 300 }}
          showSearch
          optionFilterProp="label"
          placeholder="选择客户查看专属价"
          value={customerId}
          onChange={setCustomerId}
          options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
        />
        <Button type="primary" disabled={!customerId} onClick={() => setCreateOpen(true)}>新增专属价</Button>
      </Space>
      <Table<CustomerPriceVersionDTO>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: customerId ? '暂无专属价' : '请先选择客户' }}
        columns={[
          { title: '商品', width: 200, render: (_, r) => r.product ? `${r.product.name}（${r.product.skuCode}）` : '-' },
          { title: '计价单位', dataIndex: 'unit', width: 120, render: (v: string) => labelOf(PRICE_UNIT_LABELS, v) },
          { title: '价格', dataIndex: 'price', width: 110, align: 'right' as const, render: (v: CustomerPriceVersionDTO['price']) => fmtMoney(v) },
          { title: '生效日', dataIndex: 'validFrom', width: 110, render: (v: string) => fmtDate(v) },
          { title: '失效日', dataIndex: 'validTo', width: 110, render: (v: string | null) => (v ? fmtDate(v) : '长期') },
          { title: '审批单号', dataIndex: 'approvalRef', width: 130, render: (v: string | null) => v ?? '-' },
          { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: string | null) => v ?? '-' },
        ]}
      />
      <PriceVersionModal
        open={createOpen}
        title="新增客户专属价"
        showLevel={false}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (input) => {
          if (customerId) await pricesApi.createForCustomer(customerId, input);
        }}
        onDone={() => { setCreateOpen(false); if (customerId) load(customerId); }}
      />
    </Card>
  );
}

/** 新增价格版本 Modal：商品五级价（showLevel）与客户专属价（带商品选择）共用 */
interface PriceDraftPayload {
  unit: 'BASE' | 'MIN';
  levelType: string;
  price: number;
  validFrom: string;
  validTo?: string;
  approvalRef?: string;
  note?: string;
  productId: string;
}

function PriceVersionModal({
  open, title, showLevel, onClose, onSubmit, onDone,
}: {
  open: boolean;
  title: string;
  showLevel: boolean;
  onClose: () => void;
  onSubmit: (input: PriceDraftPayload) => Promise<void>;
  onDone: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [unit, setUnit] = useState<'BASE' | 'MIN'>('BASE');
  const [levelType, setLevelType] = useState('TERMINAL');
  const [price, setPrice] = useState<number>();
  const [productId, setProductId] = useState<string>();
  const [validFrom, setValidFrom] = useState<string>(new Date().toISOString().slice(0, 10));
  const [validTo, setValidTo] = useState<string>();
  const [approvalRef, setApprovalRef] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      productsApi.list({ page: 1, pageSize: 200 })
        .then((r) => setProducts(r.items))
        .catch(() => setProducts([]));
    }
  }, [open]);

  async function submit(): Promise<void> {
    if (!showLevel && !productId) {
      message.warning('请选择商品');
      return;
    }
    if (price === undefined || price < 0) {
      message.warning('请输入正确的价格');
      return;
    }
    if (!validFrom) {
      message.warning('请选择生效日');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        unit,
        levelType,
        price,
        validFrom,
        validTo: validTo || undefined,
        approvalRef: approvalRef || undefined,
        note: note || undefined,
        productId: productId ?? '',
      });
      message.success('价格版本已新增（旧行不动，订单快照不受影响）');
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '新增失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      okText="新增版本"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {!showLevel && (
          <Select
            style={{ width: '100%' }}
            showSearch
            optionFilterProp="label"
            placeholder="选择商品"
            value={productId}
            onChange={setProductId}
            options={products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))}
          />
        )}
        <Space wrap>
          {showLevel && (
            <Select style={{ width: 150 }} value={levelType} onChange={setLevelType} options={LEVEL_OPTIONS} />
          )}
          <Select style={{ width: 150 }} value={unit} onChange={setUnit} options={UNIT_OPTIONS} />
          <InputNumber
            min={0}
            precision={2}
            style={{ width: 140 }}
            placeholder="价格"
            prefix="¥"
            value={price}
            onChange={(v) => setPrice(v ?? undefined)}
          />
        </Space>
        <Space wrap>
          <span>生效日</span>
          <Input type="date" style={{ width: 160 }} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
          <span>失效日（可空）</span>
          <Input type="date" style={{ width: 160 }} value={validTo} onChange={(e) => setValidTo(e.target.value || undefined)} />
        </Space>
        <Input
          placeholder="审批单号（专属价原则上必填）"
          value={approvalRef}
          onChange={(e) => setApprovalRef(e.target.value)}
        />
        <Input.TextArea rows={2} placeholder="备注" value={note} onChange={(e) => setNote(e.target.value)} />
      </Space>
    </Modal>
  );
}

// ═══════════════════════ 数据导入（P0-T13 / P0-07） ═══════════════════════

function ImportTab(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [kind, setKind] = useState<ImportKindDTO>('PRODUCT');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [busy, setBusy] = useState(false);

  async function doPreview(): Promise<void> {
    if (!file) {
      message.warning('请先上传 xlsx/csv 文件');
      return;
    }
    setBusy(true);
    try {
      const res = await importsApi.preview(kind, file);
      setPreview(res);
      message.info(`预览完成：${res.status}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '预览失败');
    } finally {
      setBusy(false);
    }
  }

  async function doCommit(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    try {
      await importsApi.commit(preview.batchNo);
      message.success(`批次 ${preview.batchNo} 已提交`);
      setPreview(null);
      setFile(null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }

  function doRollback(): void {
    if (!preview) return;
    modal.confirm({
      title: `回滚批次 ${preview.batchNo}？`,
      content: '回滚=冲正流水（仅期初库存/期初应收），回滚后期初类需重新执行全量盘点基准。',
      okText: '确认回滚',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBusy(true);
        try {
          await importsApi.rollback(preview.batchNo);
          message.success('已回滚');
          setPreview(null);
          setFile(null);
        } catch (e) {
          message.error(e instanceof Error ? e.message : '回滚失败');
        } finally {
          setBusy(false);
        }
      },
    });
  }

  const issueColumns = [
    { title: '行号', dataIndex: 'rowNo', width: 70 },
    { title: '键值', dataIndex: 'rowKey', width: 130, render: (v: string | null | undefined) => v ?? '-' },
    { title: '级别', dataIndex: 'level', width: 90, render: (v: ImportRowIssueDTO['level']) => {
      const meta = IMPORT_LEVEL_META[v];
      return <Tag color={meta?.color}>{meta?.label}</Tag>;
    } },
    { title: '原因码', dataIndex: 'reasonCode', width: 150 },
    { title: '说明', dataIndex: 'message', ellipsis: true },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="数据导入（存量迁移：商品→客户→价格→期初库存→期初应收）">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Select
              style={{ width: 140 }}
              value={kind}
              onChange={(v) => { setKind(v as ImportKindDTO); setPreview(null); }}
              options={IMPORT_KIND_OPTIONS}
            />
            <Upload
              maxCount={1}
              accept=".xlsx,.xls,.csv"
              beforeUpload={(f) => { setFile(f); setPreview(null); return false; }}
              onRemove={() => setFile(null)}
              fileList={file ? [{ uid: '-1', name: file.name, status: 'done' as const }] : []}
            >
              <Button icon={<UploadOutlined />}>选择文件（xlsx/csv，≤5MB）</Button>
            </Upload>
            <Button type="primary" loading={busy} onClick={doPreview}>预览校验</Button>
          </Space>
          <Alert
            type="info"
            showIcon
            message="导入即校验：预览零写入；拒批/拒行须回源文件修正后整文件重传（不做行级修补）；警告批注后可放行。"
          />
        </Space>
      </Card>

      {preview && (
        <Card size="small" title={`差异报告（批次 ${preview.batchNo} · ${preview.kind}）`}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" bordered column={5}>
              <Descriptions.Item label="总行数">{preview.total}</Descriptions.Item>
              <Descriptions.Item label="通过">{preview.passed}</Descriptions.Item>
              <Descriptions.Item label="拒行">
                <span style={{ color: preview.rejected ? '#cf1322' : undefined }}>{preview.rejected}</span>
              </Descriptions.Item>
              <Descriptions.Item label="警告">
                <span style={{ color: preview.warned ? '#d46b08' : undefined }}>{preview.warned}</span>
              </Descriptions.Item>
              <Descriptions.Item label="状态">{preview.status}</Descriptions.Item>
            </Descriptions>

            <Table<ImportRowIssueDTO>
              size="small"
              rowKey={(r) => `${r.level}-${r.rowNo}-${r.reasonCode}`}
              pagination={false}
              dataSource={[...preview.rejectBatch, ...preview.rejectRow]}
              locale={{ emptyText: '无拒批/拒行' }}
              columns={issueColumns}
            />
            <Table<ImportRowIssueDTO>
              size="small"
              rowKey={(r) => `${r.level}-${r.rowNo}-${r.reasonCode}`}
              pagination={false}
              dataSource={preview.warn}
              locale={{ emptyText: '无警告项' }}
              columns={issueColumns}
            />

            <Space>
              <Button
                type="primary"
                loading={busy}
                disabled={preview.rejectBatch.length > 0 || preview.rejected > 0}
                onClick={doCommit}
              >
                提交批次
              </Button>
              <Button danger loading={busy} onClick={doRollback}>回滚批次</Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                提交条件：拒批=0 且拒行=0（警告可带批注放行）
              </Typography.Text>
            </Space>
          </Space>
        </Card>
      )}
    </Space>
  );
}
