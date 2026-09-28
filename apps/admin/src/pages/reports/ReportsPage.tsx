// 一键报表（P1-T11）：四问看板 | 月度报表 | 库存报表 三 Tab，口径与台账一致、一键出表。
// 月度报表＝选月份 GET /reports/monthly（销售按品类条形/业务员排行/Top10 商品/应收收款退货采购汇总）；
// 库存报表＝GET /reports/inventory（批次在库×单位成本=库存金额，合计行）；
// CSV 前端生成（UTF-8 BOM，Excel 直开不乱码）。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer, ProCard } from '@ant-design/pro-components';
import {
  Alert, Button, Card, Col, Empty, Progress, Row, Select, Space,
  Statistic, Table, Tabs, Tag, Typography,
} from 'antd';
import { reportsApi } from '../../services/api';
import type {
  InventoryReportDTO, InventoryReportItemDTO, MonthlyReportDTO,
  MonthlyRepRowDTO, MonthlyTopProductDTO,
} from '../../services/api';
import { PRODUCT_CATEGORY_LABELS } from '../../constants/labels';
import { currentMonth, fmtDateTime, fmtMoney, recentMonths, toNum } from '../../utils/format';
import { FourQuestionsBoard } from './FourQuestionsPage';

/** CSV 导出（前端生成）：BOM 保证 Excel 中文不乱码；含逗号/引号/换行的单元格按 RFC 4180 转义 */
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

export default function ReportsPage(): JSX.Element {
  return (
    <PageContainer title="一键报表" subTitle="四问看板 · 月度报表 · 库存报表（口径与台账一致）">
      <Card>
        <Tabs
          defaultActiveKey="four"
          items={[
            { key: 'four', label: '四问看板', children: <FourQuestionsBoard /> },
            { key: 'monthly', label: '月度报表', children: <MonthlyTab /> },
            { key: 'inventory', label: '库存报表', children: <InventoryTab /> },
          ]}
        />
      </Card>
    </PageContainer>
  );
}

// ───────────────────────── Tab2 月度报表（经营汇总 + 三张子表，导出 CSV） ─────────────────────────

function MonthlyTab(): JSX.Element {
  const [month, setMonth] = useState<string>(currentMonth());
  const [data, setData] = useState<MonthlyReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (m: string): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setData(await reportsApi.monthly(m));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : '加载月度报表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(month); }, [month, load]);

  const byCategory = data?.salesByCategory ?? [];
  const maxCategory = byCategory.reduce((mx, r) => Math.max(mx, toNum(r.amount)), 0);
  const summary = data?.summary;

  /** 导出 CSV：汇总/品类/业务员/Top10 分节输出 */
  function exportMonthly(): void {
    if (!data) return;
    exportCsv(`月度报表-${data.month}`, [
      [`月度报表 ${data.month}`],
      [],
      ['经营汇总'],
      ['应收发生', '当月收款', '退货金额', '采购金额', '期末未结'],
      [
        toNum(summary?.charged).toFixed(2), toNum(summary?.collected).toFixed(2),
        toNum(summary?.returned).toFixed(2), toNum(summary?.purchased).toFixed(2),
        toNum(summary?.open ?? 0).toFixed(2),
      ],
      [],
      ['销售按品类'],
      ['品类', '销售额'],
      ...byCategory.map((r) => [PRODUCT_CATEGORY_LABELS[r.category] ?? r.category, toNum(r.amount).toFixed(2)]),
      [],
      ['业务员排行'],
      ['业务员', '销售额', '回款额', '单数'],
      ...(data.repRanking ?? []).map((r) => [
        r.name, toNum(r.salesAmount).toFixed(2), toNum(r.paymentAmount).toFixed(2), r.orderCount ?? 0,
      ]),
      [],
      ['Top10 商品'],
      ['商品', '编码', '数量', '金额'],
      ...(data.topProducts ?? []).map((r) => [r.name, r.skuCode, toNum(r.qty), toNum(r.amount).toFixed(2)]),
    ]);
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Space wrap>
        <Select
          style={{ width: 130 }}
          value={month}
          onChange={setMonth}
          options={recentMonths(18).map((m) => ({ value: m, label: m }))}
        />
        <Button type="primary" disabled={!data} onClick={exportMonthly}>导出 CSV</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          口径与台账一致：应收＝当月签收发生；收款＝当月确认；退货/采购＝当月收货。
        </Typography.Text>
      </Space>

      {error && (
        <Alert
          type="error" showIcon message="月度报表加载失败" description={error}
          action={<Button size="small" danger onClick={() => { void load(month); }}>重试</Button>}
        />
      )}

      {/* 应收 / 收款 / 退货 / 采购 汇总行 */}
      <Card size="small" loading={loading && !data}>
        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}>
            <Statistic title="应收发生" value={fmtMoney(summary?.charged)} />
          </Col>
          <Col xs={12} lg={6}>
            <Statistic title="当月收款" value={fmtMoney(summary?.collected)} valueStyle={{ color: '#389e0d' }} />
          </Col>
          <Col xs={12} lg={6}>
            <Statistic title="退货金额" value={fmtMoney(summary?.returned)} />
          </Col>
          <Col xs={12} lg={6}>
            <Statistic title="采购金额" value={fmtMoney(summary?.purchased)} />
          </Col>
        </Row>
        {summary?.open !== undefined && summary?.open !== null && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            期末未结 {fmtMoney(summary.open)}；生成时间 {data ? fmtDateTime(data.generatedAt) : '-'}
          </Typography.Text>
        )}
      </Card>

      {/* 销售按品类（条形=金额占最大品类比例） */}
      <ProCard title={`销售按品类（${month}）`} headerBordered loading={loading && !data}>
        {byCategory.length === 0 ? (
          <Empty description="该月份暂无品类销售数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {byCategory.map((r) => (
              <div key={r.category} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 64, fontSize: 13, flexShrink: 0 }}>
                  {PRODUCT_CATEGORY_LABELS[r.category] ?? r.category}
                </span>
                <Progress
                  style={{ flex: 1, margin: 0 }}
                  size="small"
                  percent={maxCategory > 0 ? Math.round((toNum(r.amount) / maxCategory) * 100) : 0}
                  showInfo={false}
                />
                <span style={{ width: 120, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  {fmtMoney(r.amount)}
                </span>
              </div>
            ))}
          </Space>
        )}
      </ProCard>

      {/* 业务员排行 + Top10 商品 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card size="small" title="业务员排行" loading={loading && !data}>
            <Table<MonthlyRepRowDTO>
              size="small"
              rowKey="repId"
              pagination={false}
              dataSource={data?.repRanking ?? []}
              locale={{ emptyText: '该月份暂无业务员数据' }}
              columns={[
                {
                  title: '#', width: 64,
                  render: (_v, r) => {
                    const idx = (data?.repRanking ?? []).findIndex((x) => x.repId === r.repId);
                    return idx === 0 ? <Tag color="red">Top1</Tag> : idx + 1;
                  },
                },
                { title: '业务员', dataIndex: 'name' },
                { title: '销售额', dataIndex: 'salesAmount', align: 'right' as const, render: (v) => fmtMoney(v) },
                {
                  title: '回款额', dataIndex: 'paymentAmount', align: 'right' as const,
                  render: (v) => <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span>,
                },
                { title: '单数', dataIndex: 'orderCount', align: 'right' as const, width: 70, render: (v) => v ?? 0 },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="Top10 商品" loading={loading && !data}>
            <Table<MonthlyTopProductDTO>
              size="small"
              rowKey="productId"
              pagination={false}
              dataSource={(data?.topProducts ?? []).slice(0, 10)}
              locale={{ emptyText: '该月份暂无商品销售数据' }}
              columns={[
                { title: '#', width: 48, render: (_v, r) => (data?.topProducts ?? []).findIndex((x) => x.productId === r.productId) + 1 },
                {
                  title: '商品', dataIndex: 'name', ellipsis: true,
                  render: (_v, r) => (
                    <Space size={0} direction="vertical">
                      <span>{r.name}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.skuCode}</Typography.Text>
                    </Space>
                  ),
                },
                { title: '数量', dataIndex: 'qty', align: 'right' as const, width: 90, render: (v) => toNum(v) },
                { title: '金额', dataIndex: 'amount', align: 'right' as const, width: 120, render: (v) => fmtMoney(v) },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

// ───────────────────────── Tab3 库存报表（批次×成本，合计行，导出 CSV） ─────────────────────────

function InventoryTab(): JSX.Element {
  const [data, setData] = useState<InventoryReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setData(await reportsApi.inventory());
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : '加载库存报表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const items = data?.items ?? [];
  const totalAmount = data?.totalAmount !== undefined && data?.totalAmount !== null
    ? toNum(data.totalAmount)
    : items.reduce((s, r) => s + toNum(r.amount), 0);
  const totalQty = items.reduce((s, r) => s + toNum(r.onHand), 0);

  function exportInventory(): void {
    exportCsv(`库存报表-${new Date().toISOString().slice(0, 10)}`, [
      ['库存报表'],
      ['商品', '编码', '批次', '在库', '单位成本', '库存金额'],
      ...items.map((r) => [
        r.name, r.skuCode, r.batchNo, toNum(r.onHand), toNum(r.unitCost).toFixed(4), toNum(r.amount).toFixed(2),
      ]),
      ['合计', '', '', totalQty, '', totalAmount.toFixed(2)],
    ]);
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Space wrap>
        <Button type="primary" loading={loading} onClick={() => { void load(); }}>刷新</Button>
        <Button type="primary" ghost disabled={items.length === 0} onClick={exportInventory}>导出 CSV</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          口径：批次级在库 × 单位成本（移动加权 R7 的账面口径）；生成时间 {data ? fmtDateTime(data.generatedAt) : '-'}
        </Typography.Text>
      </Space>

      {error && (
        <Alert
          type="error" showIcon message="库存报表加载失败" description={error}
          action={<Button size="small" danger onClick={() => { void load(); }}>重试</Button>}
        />
      )}

      <Card size="small" loading={loading && !data}>
        <Table<InventoryReportItemDTO>
          size="small"
          rowKey={(r) => `${r.productId}|${r.batchNo}`}
          loading={loading}
          dataSource={items}
          locale={{ emptyText: '暂无在库批次' }}
          columns={[
            {
              title: '商品', dataIndex: 'name', ellipsis: true,
              render: (_v, r) => (
                <Space size={0} direction="vertical">
                  <span>{r.name}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.skuCode}</Typography.Text>
                </Space>
              ),
            },
            { title: '批次', dataIndex: 'batchNo', width: 140 },
            { title: '在库', dataIndex: 'onHand', align: 'right' as const, width: 110, render: (v) => toNum(v) },
            { title: '单位成本', dataIndex: 'unitCost', align: 'right' as const, width: 120, render: (v) => fmtMoney(v) },
            {
              title: '库存金额', dataIndex: 'amount', align: 'right' as const, width: 130,
              render: (v) => <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span>,
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}>
                <Typography.Text strong>合计（{items.length} 个批次）</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Typography.Text strong>{totalQty}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} />
              <Table.Summary.Cell index={3} align="right">
                <Typography.Text strong>{fmtMoney(totalAmount)}</Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </Card>
    </Space>
  );
}
