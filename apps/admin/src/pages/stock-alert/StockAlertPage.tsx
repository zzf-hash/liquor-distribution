// 库存预警 + 自动报货（P2）：每日库存报表 | 报货单 | 预警配置 三 Tab。
// 报表 = GET /stock-alert/report（当日无快照后端惰性补生成）；报货单 = 内勤确认制（确认→转采购单+提审，固定老板审）；
// 配置仅老板可改（窗口/安全/覆盖天数、开关、默认供应商）。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Button, Card, Form, Input, InputNumber, message, Modal, Select, Space,
  Statistic, Switch, Table, Tabs, Tag, Typography,
} from 'antd';
import { ReloadOutlined, FileAddOutlined, SettingOutlined } from '@ant-design/icons';
import { stockAlertApi } from '../../services/stock-alert-api';
import type { StockAlertConfigDTO, StockReportDTO, StockReportItemDTO, RestockRequestDTO, ExpiryItemDTO, ExpiryListDTO } from '../../services/stock-alert-api';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';
import { getAuth } from '../../services/auth';

const LEVEL_META: Record<string, { label: string; color: string }> = {
  OK: { label: '正常', color: 'green' },
  LOW: { label: '低于阈值', color: 'orange' },
  OUT: { label: '缺货', color: 'red' },
};

const RESTOCK_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING_CLERK: { label: '待内勤确认', color: 'orange' },
  SUBMITTED: { label: '已提审(老板)', color: 'blue' },
  APPROVED: { label: '审批通过', color: 'green' },
  DISMISSED: { label: '已忽略/驳回', color: 'default' },
  CANCELLED: { label: '已取消', color: 'default' },
};

/** CSV 导出（前端生成，UTF-8 BOM）：与报表页同一套转义 */
function exportCsv(filename: string, rows: Array<Array<string | number>>): void {
  const esc = (v: string | number): string => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = `﻿${rows.map((r) => r.map(esc).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ───────────────────────── Tab1 每日库存报表 ─────────────────────────

function ReportTab(): JSX.Element {
  const [data, setData] = useState<StockReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');

  const load = useCallback(async (lv?: string): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setData(await stockAlertApi.report({ level: lv, pageSize: 200 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载库存报表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(level); }, [level, load]);

  const s = data?.summary;
  const items = data?.items ?? [];

  const doExport = (): void => {
    exportCsv(`库存报表-${data?.reportDate ?? todayStr()}`, [
      ['SKU', '商品', '现有库存(最小)', '折主单位', '近3日销', '近7日销', `窗口销`, '日均', '动态阈值', '在途', '建议报货', '状态', '库存货值'],
      ...items.map((r) => [r.skuCode, r.name, r.onHand, r.baseQty, r.sold3d, r.sold7d, r.soldWindow, r.dailyAvg, r.thresholdQty, r.inTransitQty, r.suggestedQty, LEVEL_META[r.level]?.label ?? r.level, r.stockValue]),
    ]);
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Statistic title="预警商品" value={s?.low ?? 0} valueStyle={{ color: '#fa8c16' }} />
        <Statistic title="缺货商品" value={s?.out ?? 0} valueStyle={{ color: '#cf1322' }} />
        <Statistic title="在售SKU" value={s?.totalSkus ?? 0} />
        <Statistic title="库存货值(成本)" value={s ? fmtMoney(s.totalValue) : '—'} prefix="¥" />
        <Select
          allowClear
          placeholder="全部状态"
          style={{ width: 140 }}
          value={level}
          onChange={(v) => setLevel(v)}
          options={[{ value: 'LOW', label: '仅看预警' }, { value: 'OUT', label: '仅看缺货' }, { value: 'OK', label: '仅看正常' }]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(level)}>刷新</Button>
        <Button onClick={doExport} disabled={items.length === 0}>导出 CSV</Button>
      </Space>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <Table<StockReportItemDTO>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (t) => `共 ${t} 行` }}
        scroll={{ x: 1100 }}
        columns={[
          { title: 'SKU', dataIndex: 'skuCode', width: 100 },
          { title: '商品', dataIndex: 'name', width: 180, ellipsis: true },
          { title: '库存', width: 110, render: (_, r) => <span>{r.onHand} <Typography.Text type="secondary">({r.baseQty} 主)</Typography.Text></span> },
          { title: '近3日', dataIndex: 'sold3d', width: 70, align: 'right' },
          { title: '近7日', dataIndex: 'sold7d', width: 70, align: 'right' },
          { title: '日均', dataIndex: 'dailyAvg', width: 70, align: 'right' },
          { title: '阈值', dataIndex: 'thresholdQty', width: 70, align: 'right' },
          { title: '在途', dataIndex: 'inTransitQty', width: 70, align: 'right' },
          { title: '建议报货', dataIndex: 'suggestedQty', width: 90, align: 'right', render: (v) => (toNum(v) > 0 ? <b>{v}</b> : '—') },
          { title: '状态', dataIndex: 'level', width: 90, render: (lv) => <Tag color={LEVEL_META[lv]?.color}>{LEVEL_META[lv]?.label ?? lv}</Tag> },
          { title: '报货单', width: 130, render: (_, r) => r.restock ? <Tag color={RESTOCK_STATUS_META[r.restock.status]?.color}>{r.restock.requestId}</Tag> : '—' },
          { title: '货值', dataIndex: 'stockValue', width: 100, align: 'right', render: (v) => fmtMoney(toNum(v)) },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Tab2 临期预警（M2-3 效期维度，啤酒/红酒刚需） ─────────────────────────

const EXPIRY_LEVEL_META: Record<string, { label: string; color: string }> = {
  EXPIRED: { label: '已过期', color: 'red' },
  WARNING: { label: '临期', color: 'orange' },
};

function ExpiryTab(): JSX.Element {
  const [data, setData] = useState<ExpiryListDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setData(await stockAlertApi.expiry());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载临期预警失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const items = data?.items ?? [];
  const s = data?.summary;

  const doExport = (): void => {
    exportCsv(`临期预警-${todayStr()}`, [
      ['SKU', '商品', '批次', '库位', '到期日', '剩余天数', '状态', '批次库存(最小)', '货值(成本)'],
      ...items.map((r: ExpiryItemDTO) => [r.skuCode, r.productName, r.batchNo, r.location ?? '', r.expiryDate, r.daysLeft, EXPIRY_LEVEL_META[r.level]?.label ?? r.level, r.onHand, r.stockValue]),
    ]);
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Statistic title="临期批次" value={s?.warning ?? 0} valueStyle={{ color: '#fa8c16' }} />
        <Statistic title="已过期批次" value={s?.expired ?? 0} valueStyle={{ color: '#cf1322' }} />
        <Statistic title="涉及货值(成本)" value={s ? fmtMoney(s.valueAtRisk) : '—'} prefix="¥" />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          预警窗口：到期前 {data?.warnDays ?? 30} 天（预警配置 Tab 可调）；已过期批次不可拣货（FEFO 自动排除）
        </Typography.Text>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        <Button onClick={doExport} disabled={items.length === 0}>导出 CSV</Button>
      </Space>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <Table<ExpiryItemDTO>
        rowKey="batchId"
        size="small"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        locale={{ emptyText: `预警窗口内没有在库批次（现有批次到期日均在 ${data?.warnDays ?? 30} 天以外）` }}
        columns={[
          { title: 'SKU', dataIndex: 'skuCode', width: 100 },
          { title: '商品', dataIndex: 'productName', width: 180, ellipsis: true },
          { title: '批次', dataIndex: 'batchNo', width: 140 },
          { title: '库位', dataIndex: 'location', width: 110, render: (v) => v || '—' },
          { title: '到期日', dataIndex: 'expiryDate', width: 110 },
          { title: '剩余天数', dataIndex: 'daysLeft', width: 90, align: 'right', render: (v) => (v < 0 ? <b style={{ color: '#cf1322' }}>{v}</b> : v) },
          { title: '状态', dataIndex: 'level', width: 90, render: (lv) => <Tag color={EXPIRY_LEVEL_META[lv]?.color}>{EXPIRY_LEVEL_META[lv]?.label ?? lv}</Tag> },
          { title: '批次库存', dataIndex: 'onHand', width: 100, align: 'right' },
          { title: '货值', dataIndex: 'stockValue', width: 100, align: 'right', render: (v) => fmtMoney(toNum(v)) },
        ]}
      />
    </div>
  );
}

// ───────────────────────── Tab3 报货单（内勤确认制） ─────────────────────────

function RestockTab(): JSX.Element {
  const [items, setItems] = useState<RestockRequestDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('PENDING_CLERK');
  const [confirmTarget, setConfirmTarget] = useState<RestockRequestDTO | null>(null);
  const [dismissTarget, setDismissTarget] = useState<RestockRequestDTO | null>(null);
  const [confirmForm] = Form.useForm();
  const [dismissForm] = Form.useForm();

  const load = useCallback(async (st?: string): Promise<void> => {
    setLoading(true);
    try {
      const res = await stockAlertApi.restocks({ status: st || undefined, pageSize: 100 });
      setItems(res.items);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '加载报货单失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(status); }, [status, load]);

  const doConfirm = async (): Promise<void> => {
    if (!confirmTarget) return;
    const v = await confirmForm.validateFields();
    try {
      const r = await stockAlertApi.confirmRestock(confirmTarget.id, { qty: v.qty, supplier: v.supplier || undefined, type: v.type, note: v.note || undefined });
      message.success(`已转采购单 ${r.purNo} 并提交老板审批`);
      setConfirmTarget(null);
      void load(status);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '提交失败');
    }
  };

  const doDismiss = async (): Promise<void> => {
    if (!dismissTarget) return;
    const v = await dismissForm.validateFields();
    try {
      await stockAlertApi.dismissRestock(dismissTarget.id, v.reason);
      message.success('已忽略（次日扫描仍会重新评估）');
      setDismissTarget(null);
      void load(status);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select
          style={{ width: 180 }}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'PENDING_CLERK', label: '待我确认' },
            { value: 'SUBMITTED', label: '已提审' },
            { value: 'APPROVED', label: '审批通过' },
            { value: 'DISMISSED', label: '已忽略/驳回' },
            { value: '', label: '全部' },
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(status)}>刷新</Button>
      </Space>
      <Table<RestockRequestDTO>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        columns={[
          { title: '单号', dataIndex: 'requestId', width: 140 },
          { title: '商品', render: (_, r) => `${r.product.name}（${r.product.skuCode}）`, ellipsis: true },
          { title: '建议数量', width: 110, align: 'right', render: (_, r) => `${r.baseQty} 主（${r.qty} 最小）` },
          { title: '生成时点', width: 210, render: (_, r) => <span>库存 {r.onHand} / 阈值 {r.thresholdQty} / 日均 {r.dailyAvg}</span> },
          { title: '供应商', dataIndex: ['product', 'supplier'], width: 110, render: (v) => v || <Typography.Text type="secondary">用默认</Typography.Text> },
          { title: '状态', dataIndex: 'status', width: 120, render: (st) => <Tag color={RESTOCK_STATUS_META[st]?.color}>{RESTOCK_STATUS_META[st]?.label ?? st}</Tag> },
          { title: '生成时间', dataIndex: 'createdAt', width: 150, render: (v) => fmtDateTime(v) },
          {
            title: '操作', width: 150,
            render: (_, r) => r.status === 'PENDING_CLERK' ? (
              <Space>
                <Button type="primary" size="small" icon={<FileAddOutlined />} onClick={() => { setConfirmTarget(r); confirmForm.setFieldsValue({ qty: r.qty, supplier: r.product.supplier ?? '', type: 'POSTPAID', note: '' }); }}>确认报货</Button>
                <Button size="small" onClick={() => { setDismissTarget(r); dismissForm.setFieldsValue({ reason: '' }); }}>忽略</Button>
              </Space>
            ) : r.purchaseId ? <Typography.Text copyable={{ text: r.purchaseId }} type="secondary">采购单已建</Typography.Text> : '—',
          },
        ]}
      />
      <Modal
        title={`确认报货 ${confirmTarget?.requestId ?? ''}`}
        open={confirmTarget !== null}
        onOk={() => void doConfirm()}
        onCancel={() => setConfirmTarget(null)}
        okText="转采购单并提审"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          确认后生成正式采购单并直接提交审批（自动报货固定由老板审批）。数量与供应商可在此调整。
        </Typography.Paragraph>
        <Form form={confirmForm} layout="vertical">
          <Form.Item name="qty" label="报货数量（最小单位）" rules={[{ required: true, message: '必填' }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="supplier" label="供应商">
            <Input placeholder="留空用商品档案/默认配置" />
          </Form.Item>
          <Form.Item name="type" label="采购类型">
            <Select options={[{ value: 'POSTPAID', label: '后付 F4（审批→收货→付款）' }, { value: 'PREPAID', label: '先付 F3（审批→付款→收货）' }]} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`忽略 ${dismissTarget?.requestId ?? ''}`}
        open={dismissTarget !== null}
        onOk={() => void doDismiss()}
        onCancel={() => setDismissTarget(null)}
        okText="忽略"
      >
        <Form form={dismissForm} layout="vertical">
          <Form.Item name="reason" label="忽略原因（必填，留痕）" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea rows={2} placeholder="如：近期促销已单独补货 / 该品即将下架" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ───────────────────────── Tab3 预警配置（仅老板） ─────────────────────────

function ConfigTab(): JSX.Element {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const role = getAuth()?.role;
  const isOwner = role === 'owner';

  useEffect(() => {
    void stockAlertApi.getConfig().then((c: StockAlertConfigDTO) => {
      form.setFieldsValue({ windowDays: c.windowDays, safetyDays: c.safetyDays, coverageDays: c.coverageDays, enabled: c.enabled, defaultSupplier: c.defaultSupplier });
    }).catch((e: unknown) => message.error(e instanceof Error ? e.message : '加载配置失败'));
    void stockAlertApi.getExpiryConfig().then((c) => {
      form.setFieldsValue({ expiryWarnDays: c.warnDays, expiryEnabled: c.enabled });
    }).catch(() => {/* 临期配置缺省(默认30天) */});
  }, [form]);

  const save = async (): Promise<void> => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await Promise.all([
        stockAlertApi.saveConfig({
          windowDays: v.windowDays, safetyDays: v.safetyDays, coverageDays: v.coverageDays,
          enabled: v.enabled, defaultSupplier: v.defaultSupplier,
        }),
        stockAlertApi.saveExpiryConfig({ warnDays: v.expiryWarnDays, enabled: v.expiryEnabled }),
      ]);
      message.success('配置已保存（次日扫描生效；立即生效可点报表页「刷新」前的手动扫描）');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={{ maxWidth: 560 }}>
      <Form form={form} layout="vertical" disabled={!isOwner}>
        <Form.Item name="windowDays" label="销量窗口（日）— 动态阈值用的均线" rules={[{ required: true }]}>
          <InputNumber min={1} max={90} style={{ width: 200 }} addonAfter="日" />
        </Form.Item>
        <Form.Item name="safetyDays" label="安全天数 — 阈值 = 日均销量 × 该天数" rules={[{ required: true }]}>
          <InputNumber min={0} max={90} style={{ width: 200 }} addonAfter="日" />
        </Form.Item>
        <Form.Item name="coverageDays" label="报货覆盖天数 — 建议量补足到未来N天销量" rules={[{ required: true }]}>
          <InputNumber min={1} max={90} style={{ width: 200 }} addonAfter="日" />
        </Form.Item>
        <Form.Item name="enabled" label="自动报货单" valuePropName="checked">
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>
        <Form.Item name="defaultSupplier" label="默认供应商（商品档案未填时用）">
          <Input />
        </Form.Item>
        <Form.Item name="expiryWarnDays" label="临期预警窗口 — 到期前 N 天的批次进临期清单" rules={[{ required: true }]}>
          <InputNumber min={1} max={365} style={{ width: 200 }} addonAfter="日" />
        </Form.Item>
        <Form.Item name="expiryEnabled" label="临期预警（每日库存摘要推送临期条数）" valuePropName="checked">
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>
        {isOwner ? <Button type="primary" icon={<SettingOutlined />} loading={saving} onClick={() => void save()}>保存配置</Button> : <Typography.Text type="secondary">仅老板可修改配置</Typography.Text>}
      </Form>
    </Card>
  );
}

// ───────────────────────── 页面 ─────────────────────────

export default function StockAlertPage(): JSX.Element {
  return (
    <PageContainer title="库存预警" subTitle="每日库存报表 · 动态阈值预警 · 自动报货（内勤确认→老板审批）">
      <Card>
        <Tabs
          defaultActiveKey="report"
          items={[
            { key: 'report', label: '每日库存报表', children: <ReportTab /> },
            { key: 'expiry', label: '临期预警', children: <ExpiryTab /> },
            { key: 'restocks', label: '报货单', children: <RestockTab /> },
            { key: 'config', label: '预警配置', children: <ConfigTab /> },
          ]}
        />
      </Card>
    </PageContainer>
  );
}
