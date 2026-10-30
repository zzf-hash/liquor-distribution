// 特单（P1-T02，F8 全员下单+婚宴宴席）：DRAFT→PENDING_PRICE→APPROVED→CONVERTED/REJECTED
// 红线：未经定价审批不可出货——「转正式订单」仅在 APPROVED 可用，其余状态禁用。
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  App as AntApp, Button, Descriptions, Input, Space, Tag, Typography,
} from 'antd';
import { Panel, PlainTable } from '../../components/light-ui';
import type { PlainColumn } from '../../components/light-ui';
const CreateSpecialOrderModal = lazy(() => import('./special-order-modal'));
import { customersApi, productsApi, specialOrdersApi } from '../../services/api';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import type {
  CustomerDTO,
  ProductDTO,
  SpecialOrderDTO,
  SpecialOrderLineDTO,
} from '../../services/api';
import {
  SPECIAL_ORDER_STATUS_META,
  SPECIAL_ORDER_STATUS_TABS,
  labelOf,
} from '../../constants/labels';
import { fmtDate, fmtDateTime, fmtMoney, toNum } from '../../utils/format';

/** 特单合计（行金额=数量×单价，后端为准） */
function specialTotal(lines: SpecialOrderLineDTO[] | undefined): number {
  return (lines ?? []).reduce((sum, l) => sum + toNum(l.qty) * toNum(l.price), 0);
}

export default function SpecialOrdersPage(): JSX.Element {
  const { message, modal } = AntApp.useApp();
  const [activeStatus, setActiveStatus] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rows, setRows] = useState<SpecialOrderDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const idemRef = useRef<IdemSlot | null>(null);

  const reload = (): void => setRefreshKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    specialOrdersApi.list({
      status: activeStatus === 'ALL' ? undefined : activeStatus,
      q: keyword || undefined,
      page,
      pageSize,
    }).then((res) => {
      if (!alive) return;
      setRows(res.items ?? []);
      setTotal(res.total);
    }).catch((e) => {
      if (!alive) return;
      message.error(e instanceof Error ? e.message : '加载特单失败');
      setRows([]);
      setTotal(0);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeStatus, keyword, page, pageSize, refreshKey]);

  /** DRAFT → 提交定价审批（审批中心 PRICE_SPECIAL 线生成待办） */
  function submitForPrice(r: SpecialOrderDTO): void {
    modal.confirm({
      title: `提交定价审批？${r.specialNo}`,
      content: `「${r.title}」提交后进入审批中心（特单价格线），审批通过后方可转正式订单出货。`,
      okText: '提交审批',
      cancelText: '再想想',
      onOk: async () => {
        try {
          await specialOrdersApi.submit(r.id);
          message.success(`已提交定价审批：${r.specialNo}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '提交失败');
        }
      },
    });
  }

  /** APPROVED → 转正式订单（红线闸门：未 APPROVED 服务端拒绝） */
  async function convert(r: SpecialOrderDTO): Promise<void> {
    modal.confirm({
      title: `转正式订单？${r.specialNo}`,
      content: `「${r.title}」将按已审批价格生成正式销售订单，转单后特单状态变为「已转单」。`,
      okText: '转正式订单',
      cancelText: '再想想',
      onOk: async () => {
        try {
          const res = await specialOrdersApi.convert(r.id, rememberIdemKey(idemRef, { convert: r.id }));
          idemRef.current = null;
          message.success(`已转正式订单：${res.orderNo ?? res.convertedOrderId ?? '见订单池'}`);
          reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '转单失败');
        }
      },
    });
  }

  const columns: Array<PlainColumn<SpecialOrderDTO>> = [
    { title: '特单号', dataIndex: 'specialNo', width: 170, render: (_, r) => <Typography.Text copyable>{r.specialNo}</Typography.Text> },
    { title: '标题', dataIndex: 'title' },
    { title: '客户', dataIndex: 'customerName', width: 140, render: (_, r) => (
      <Space size={4}>
        <span>{r.customerName}</span>
        {!r.customerId && <Typography.Text type="secondary" style={{ fontSize: 12 }}>散客</Typography.Text>}
      </Space>
    ) },
    { title: '宴席', dataIndex: 'isBanquet', width: 80, render: (_, r) => r.isBanquet ? <Tag color="gold">宴席</Tag> : '-' },
    {
      title: '状态', dataIndex: 'status', width: 110,
      render: (_, r) => {
        const meta = SPECIAL_ORDER_STATUS_META[r.status];
        return <Tag color={meta?.color}>{meta?.label ?? r.status}</Tag>;
      },
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 150, render: (_, r) => fmtDateTime(r.createdAt) },
    {
      title: '操作', width: 220,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'DRAFT' && <a onClick={() => submitForPrice(r)}>提交定价审批</a>}
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={r.status !== 'APPROVED'}
            title={r.status !== 'APPROVED' ? '红线：未经定价审批不可出货' : undefined}
            onClick={() => convert(r)}
          >
            转正式订单
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>特单</Typography.Title>
      <Typography.Paragraph type="secondary">F8 全员下单 · 婚宴宴席用酒 · 未经定价审批不可出货（红线）</Typography.Paragraph>
      <Panel>
        <Space style={{ marginBottom: 12 }} wrap>
          <select
            value={activeStatus}
            onChange={(e) => { setActiveStatus(e.target.value); setPage(1); reload(); }}
          >
            {SPECIAL_ORDER_STATUS_TABS.map((tab) => <option key={String(tab.value)} value={tab.value}>{tab.label}</option>)}
          </select>
          <Input.Search
            style={{ width: 260 }}
            placeholder="特单号 / 标题 / 客户名"
            allowClear
            onSearch={(v) => { setKeyword(v); setPage(1); reload(); }}
          />
          <Button type="primary" onClick={() => setCreateOpen(true)}>新建特单</Button>
        </Space>
        <PlainTable
          loading={loading}
          dataSource={rows}
          columns={columns}
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          expandable={{ expandedRowRender: (r) => <SpecialOrderDetailCard order={r} /> }}
        />
      </Panel>

      {createOpen ? (
        <Suspense fallback={null}>
          <CreateSpecialOrderModal
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onCreated={() => { setCreateOpen(false); reload(); }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

// ───────────────────────── 行展开：特单字段 + 行明细 ─────────────────────────

function SpecialOrderDetailCard({ order }: { order: SpecialOrderDTO }): JSX.Element {
  const [detail, setDetail] = useState<SpecialOrderDTO | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    specialOrdersApi
      .detail(order.id)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => {
        // 明细接口未就绪时退回列表行数据（行数可能缺失）
        if (alive) setDetail(order);
      });
    return () => { alive = false; };
  }, [order]);

  if (!detail) return <Panel>加载中</Panel>;
  const lines = detail.lines ?? [];

  return (
    <Panel title={`特单详情（${lines.length} 行 · 合计 ${fmtMoney(specialTotal(lines))}）`}>
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="联系人">{detail.contactName}</Descriptions.Item>
        <Descriptions.Item label="联系电话">{detail.contactPhone}</Descriptions.Item>
        <Descriptions.Item label="地址" span={2}>{detail.address}</Descriptions.Item>
        {detail.isBanquet && (
          <>
            <Descriptions.Item label="宴席日期">{fmtDate(detail.eventDate)}</Descriptions.Item>
            <Descriptions.Item label="宴席地点">{detail.venue ?? '-'}</Descriptions.Item>
          </>
        )}
        <Descriptions.Item label="配送时间">{fmtDate(detail.deliveryDate)}</Descriptions.Item>
        <Descriptions.Item label="收款人 / 截止">
          {detail.payeeName ?? '-'}{detail.payDueDate ? ` / ${fmtDate(detail.payDueDate)}` : ''}
        </Descriptions.Item>
        {detail.note && <Descriptions.Item label="备注" span={2}>{detail.note}</Descriptions.Item>}
        {detail.status === 'CONVERTED' && (
          <Descriptions.Item label="正式订单" span={2}>
            <Typography.Text copyable>{detail.orderNo ?? detail.convertedOrderId ?? '-'}</Typography.Text>
          </Descriptions.Item>
        )}
      </Descriptions>
      <PlainTable<SpecialOrderLineDTO>
        dataSource={lines}
        emptyText="无明细行"
        columns={[
          { title: '品名', dataIndex: 'productName', render: (_v, r) => (
            <Space size={4}>
              <span>{r.productName}</span>
              {r.specText && <Typography.Text type="secondary">{r.specText}</Typography.Text>}
              {!r.productId && <Tag>自由品名</Tag>}
            </Space>
          ) },
          { title: '单位', dataIndex: 'unit', width: 90 },
          { title: '数量', dataIndex: 'qty', width: 100, align: 'right' as const, render: (v) => toNum(v) },
          { title: '单价', dataIndex: 'price', width: 110, align: 'right' as const, render: (v) => fmtMoney(v) },
          { title: '金额', width: 120, align: 'right' as const, render: (_v, r) => fmtMoney(toNum(r.qty) * toNum(r.price)) },
        ]}
      />
    </Panel>
  );
}

