// 老板四问看板（P0-T40）：今日卖多少收多少 / 谁欠钱 / 什么货快没了 / 哪个业务员强
// 接口契约：GET /dashboard/four-questions（OWNER，信封 {code:0,data}，主 agent 并行开发）；
// 口径（页面底部小字）：今日销售＝当日签收订单额，今日回款＝当日确认收款额；数据延迟＝实时。
import { useCallback, useEffect, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { ReloadOutlined } from '@ant-design/icons';
import {
  Alert, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography,
} from 'antd';
import { clearAuth, getAuth } from '../../services/auth';
import { AR_BUCKET_TABS } from '../../constants/labels';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';
import type { Decimalish } from '../../utils/format';

const API_BASE: string = import.meta.env.VITE_API_BASE || '/api';
const NEG = '#cf1322'; // 低可售/预警红（与订单池红字同色）

// ───────────────────────── 契约类型（/dashboard/four-questions data） ─────────────────────────

interface TopDebtorDTO {
  customerId: string;
  name: string;
  open: Decimalish;
}

interface LowStockDTO {
  productId: string;
  skuCode: string;
  name: string;
  onHand: Decimalish;
  occupied: Decimalish;
  available: Decimalish;
  daysCover?: number | null;
}

interface RepRankDTO {
  userId: string;
  name: string;
  salesAmount: Decimalish;
  paymentAmount: Decimalish;
  orderCount: number;
}

export interface FourQuestionsDTO {
  salesToday: { amount: Decimalish; orderCount: number };
  collectedToday: { amount: Decimalish; paymentCount: number };
  debt: {
    total: Decimalish;
    buckets: Record<string, Decimalish>;
    topDebtors: TopDebtorDTO[]; // 未结降序，最多8条
  };
  lowStock: LowStockDTO[]; // 可售<阈值，最多10条
  repRanking: RepRankDTO[]; // 按回款降序5条
  generatedAt: string;
}

// 本页自取数（/dashboard 接口未入 services/api.ts，随主 agent 落地后归并）
async function fetchFourQuestions(): Promise<FourQuestionsDTO> {
  const auth = getAuth();
  const headers: Record<string, string> = {};
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(`${API_BASE}/dashboard/four-questions`, { headers });
  if (res.status === 401) {
    clearAuth();
    window.location.href = '/login';
    throw new Error('登录已过期，请重新登录');
  }
  let body: { code?: number; data?: FourQuestionsDTO; message?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.code !== 0 || !body.data) {
    throw new Error(body?.message || `加载看板失败（HTTP ${res.status}）`);
  }
  return body.data;
}

const BUCKET_TAG_COLORS: Record<string, string> = {
  not_due: 'default',
  d1_30: 'gold',
  d31_60: 'orange',
  d61_90: 'volcano',
  d90p: 'red',
  disputed: 'purple',
};

export default function FourQuestionsPage(): JSX.Element {
  const [data, setData] = useState<FourQuestionsDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchFourQuestions());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载看板失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const debtBuckets = data?.debt.buckets ?? {};
  const shownBuckets = AR_BUCKET_TABS.filter((b) => toNum(debtBuckets[b.key]) > 0);

  return (
    <PageContainer
      title="老板四问看板"
      subTitle="今日经营一屏看全（P0-T40）"
      extra={[
        <Button key="reload" type="primary" ghost icon={<ReloadOutlined />} onClick={() => { void load(); }}>
          刷新
        </Button>,
      ]}
    >
      {error && (
        <Alert
          style={{ marginBottom: 16 }}
          type="error"
          message="看板加载失败"
          description={error}
          action={<Button size="small" danger onClick={() => { void load(); }}>重试</Button>}
        />
      )}
      <Row gutter={[16, 16]}>
        {/* 一问+二问：今日卖多少 · 收多少 */}
        <Col xs={24} lg={12}>
          <Card title="今日卖多少 · 收多少" extra={<Tag color="green">实时</Tag>} loading={loading && !data}>
            <Row gutter={16}>
              <Col span={12}>
                <Statistic title="今日销售" value={fmtMoney(data?.salesToday.amount)} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当日签收 {data?.salesToday.orderCount ?? 0} 单
                </Typography.Text>
              </Col>
              <Col span={12}>
                <Statistic title="今日回款" value={fmtMoney(data?.collectedToday.amount)} valueStyle={{ color: '#389e0d' }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  确认收款 {data?.collectedToday.paymentCount ?? 0} 笔
                </Typography.Text>
              </Col>
            </Row>
          </Card>
        </Col>

        {/* 三问：谁欠钱 */}
        <Col xs={24} lg={12}>
          <Card title="谁欠钱（应收未结）" extra={<Tag color="green">实时</Tag>} loading={loading && !data}>
            <Statistic title="未结总额" value={fmtMoney(data?.debt.total)} valueStyle={{ color: NEG }} />
            <Space style={{ marginTop: 8 }} wrap size={4}>
              {shownBuckets.length ? shownBuckets.map((b) => (
                <Tag key={b.key} color={BUCKET_TAG_COLORS[b.key]}>
                  {b.label} {fmtMoney(debtBuckets[b.key])}
                </Tag>
              )) : <Tag>暂无账龄分布</Tag>}
            </Space>
            <Table<TopDebtorDTO>
              style={{ marginTop: 12 }}
              size="small"
              rowKey="customerId"
              pagination={false}
              dataSource={data?.debt.topDebtors ?? []}
              locale={{ emptyText: '暂无未结客户' }}
              columns={[
                { title: '欠款最多的客户', dataIndex: 'name' },
                {
                  title: '未结金额', dataIndex: 'open', align: 'right',
                  render: (v: TopDebtorDTO['open']) => fmtMoney(v),
                },
              ]}
            />
          </Card>
        </Col>

        {/* 四问：什么货快没了 */}
        <Col xs={24} lg={12}>
          <Card title="什么货快没了（可售低于阈值）" extra={<Tag color="green">实时</Tag>} loading={loading && !data}>
            <Table<LowStockDTO>
              size="small"
              rowKey="productId"
              pagination={false}
              dataSource={data?.lowStock ?? []}
              locale={{ emptyText: '库存充足，暂无低可售商品' }}
              columns={[
                {
                  title: '商品', dataIndex: 'name',
                  render: (_: unknown, r: LowStockDTO) => (
                    <Space direction="vertical" size={0}>
                      <span>{r.name}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.skuCode}</Typography.Text>
                    </Space>
                  ),
                },
                { title: '在库', dataIndex: 'onHand', align: 'right', render: (v: LowStockDTO['onHand']) => toNum(v) },
                { title: '占用', dataIndex: 'occupied', align: 'right', render: (v: LowStockDTO['occupied']) => toNum(v) },
                {
                  title: '可售', dataIndex: 'available', align: 'right',
                  render: (v: LowStockDTO['available']) => (
                    <span style={{ fontWeight: 600, color: toNum(v) <= 0 ? NEG : undefined }}>{toNum(v)}</span>
                  ),
                },
                {
                  title: '可售天数', dataIndex: 'daysCover', align: 'right', width: 90,
                  render: (v: LowStockDTO['daysCover']) => (v === null || v === undefined ? '-' : `${v} 天`),
                },
              ]}
            />
          </Card>
        </Col>

        {/* 五问（合一张卡）：哪个业务员强 */}
        <Col xs={24} lg={12}>
          <Card
            title="哪个业务员强"
            extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按当日回款降序</Typography.Text>}
            loading={loading && !data}
          >
            <Table<RepRankDTO>
              size="small"
              rowKey="userId"
              pagination={false}
              dataSource={data?.repRanking ?? []}
              locale={{ emptyText: '暂无业务员数据' }}
              columns={[
                {
                  title: '#', width: 64,
                  render: (_: unknown, r: RepRankDTO) => {
                    const idx = (data?.repRanking ?? []).findIndex((x) => x.userId === r.userId);
                    return idx === 0 ? <Tag color="red">Top1</Tag> : idx + 1;
                  },
                },
                { title: '业务员', dataIndex: 'name' },
                { title: '销售额', dataIndex: 'salesAmount', align: 'right', render: (v: RepRankDTO['salesAmount']) => fmtMoney(v) },
                {
                  title: '回款额', dataIndex: 'paymentAmount', align: 'right',
                  render: (v: RepRankDTO['paymentAmount']) => <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span>,
                },
                { title: '单数', dataIndex: 'orderCount', align: 'right', width: 70 },
              ]}
            />
          </Card>
        </Col>
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
        口径：今日销售＝当日签收订单金额；今日回款＝当日确认收款金额。数据延迟：实时。
        生成时间：{data ? fmtDateTime(data.generatedAt) : '-'}
      </Typography.Text>
    </PageContainer>
  );
}
