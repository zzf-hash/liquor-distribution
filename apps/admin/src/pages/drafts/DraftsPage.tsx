// 转单草稿（P1-T12）：语音/拍照/文字 → 可编辑草稿 → 人工确认转单。
// 红线（D16/Q13）：草稿永远可编辑；确认转单只建 PENDING_CONFIRM 订单（不直接出库）；
// 低置信度（confidence < 0.7）红条强提示，必须逐项人工核对；确认时别名自动学习（AUTO_LEARNED）。
import { useEffect, useRef, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert, App as AntApp, Badge, Button, Card, Drawer, Empty, Input, InputNumber, List,
  Modal, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography,
} from 'antd';
import { aliasesApi, customersApi, draftsApi, productsApi } from '../../services/api';
import type {
  AliasEntryDTO, AliasKindDTO, CustomerDTO, DraftItemDTO, DraftSourceDTO,
  DraftStatusDTO, OrderDraftDTO, ProductDTO,
} from '../../services/api';
import { DRAFT_SOURCE_META, DRAFT_STATUS_META } from '../../constants/labels';
import { fmtDateTime, fmtMoney, toNum } from '../../utils/format';

/** webkitSpeechRecognition 最小类型（Chrome 私有 API，TS 无内置声明） */
interface SrAlternative {
  transcript: string;
}
interface SrResult extends ArrayLike<SrAlternative> {
  isFinal: boolean;
}
interface SrEvent {
  resultIndex: number;
  results: ArrayLike<SrResult>;
}
interface SrInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SrEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SrCtor = new () => SrInstance;

/** 浏览器语音识别可用性（不可用降级手输文字） */
function getSpeechRecognition(): SrCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SrCtor; webkitSpeechRecognition?: SrCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const DRAFT_STATUS_TAB_ITEMS: Array<{ key: DraftStatusDTO; label: string }> = [
  { key: 'PENDING_REVIEW', label: '待确认' },
  { key: 'CONFIRMED', label: '已转单' },
  { key: 'DISCARDED', label: '已废弃' },
];

/** 单位选项（草稿行原文口径）；确认转单时 瓶→MIN、箱→BASE */
const UNIT_OPTIONS = [{ value: '箱', label: '箱' }, { value: '瓶', label: '瓶' }];

export default function DraftsPage(): JSX.Element {
  const [engine, setEngine] = useState<{ available: boolean; baseUrl: string; engine: string } | null>(null);
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [aliasOpen, setAliasOpen] = useState(false);
  const [editing, setEditing] = useState<OrderDraftDTO | null>(null);

  const reload = (): void => setRefreshKey((k) => k + 1);

  useEffect(() => {
    draftsApi.engineStatus().then(setEngine).catch(() => setEngine(null));
    customersApi.list({ page: 1, pageSize: 200, onboarding: 'ACTIVE' })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
    productsApi.list({ page: 1, pageSize: 200, status: 'ON_SALE' })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, []);

  return (
    <PageContainer title="转单草稿" subTitle="语音 / 拍照 / 文字接单 · 草稿永远可编辑 · 确认转单只进订单池，不直接出库（红线）">
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Tooltip title={engine ? `${engine.engine} @ ${engine.baseUrl}` : '引擎状态获取失败，按人工模式处理'}>
            <Badge
              status={engine?.available ? 'success' : 'warning'}
              text={engine?.available ? '引擎在线（qwen 自动解析）' : '人工模式（引擎离线，草稿留空人工填）'}
            />
          </Tooltip>
          <Button onClick={() => setAliasOpen(true)}>别名词典</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>新建草稿</Button>
        </Space>
        <Tabs
          defaultActiveKey="PENDING_REVIEW"
          items={DRAFT_STATUS_TAB_ITEMS.map((t) => ({
            key: t.key,
            label: t.label,
            children: (
              <DraftList
                status={t.key}
                refreshKey={refreshKey}
                customers={customers}
                onOpen={(d) => setEditing(d)}
              />
            ),
          }))}
        />
      </Card>

      <CreateDraftModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(d) => {
          setCreateOpen(false);
          reload();
          setEditing(d); // 建完直接进编辑抽屉核对
        }}
      />

      <DraftEditDrawer
        draft={editing}
        customers={customers}
        products={products}
        onClose={() => setEditing(null)}
        onChanged={reload}
      />

      <AliasDrawer
        open={aliasOpen}
        onClose={() => setAliasOpen(false)}
        customers={customers}
        products={products}
      />
    </PageContainer>
  );
}

// ───────────────────────── 草稿卡片列表（按状态 Tab） ─────────────────────────

function DraftList({
  status, refreshKey, customers, onOpen,
}: {
  status: DraftStatusDTO;
  refreshKey: number;
  customers: CustomerDTO[];
  onOpen: (d: OrderDraftDTO) => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<OrderDraftDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    draftsApi.list({ status, page: 1, pageSize: 50 })
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => {
        if (alive) message.error(e instanceof Error ? e.message : '加载草稿失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [status, refreshKey, message]);

  const customerName = (d: OrderDraftDTO): string => {
    if (d.customerId) return customers.find((c) => c.id === d.customerId)?.name ?? '客户已删除';
    return d.customerHint ? `线索：${d.customerHint}` : '未定客户';
  };

  if (loading) return <Spin style={{ display: 'block', margin: '32px auto' }} />;
  if (!items.length) return <Empty description={total ? '本页无数据' : '暂无草稿'} style={{ margin: '32px 0' }} />;

  return (
    <List
      dataSource={items}
      pagination={{ pageSize: 10, size: 'small' }}
      renderItem={(d) => (
        <List.Item style={{ padding: '6px 0' }}>
          <Card
            size="small"
            hoverable
            style={{ width: '100%', cursor: 'pointer' }}
            onClick={() => onOpen(d)}
            styles={{ body: { padding: '10px 16px' } }}
          >
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space size={8} wrap>
                <Typography.Text strong>{d.draftNo}</Typography.Text>
                <Tag color={DRAFT_SOURCE_META[d.source]?.color}>
                  {d.source === 'VOICE' ? '语音🎙️' : d.source === 'PHOTO' ? '拍照📷' : '文字📝'}
                </Tag>
                <Tag color={toNum(d.confidence) >= 0.7 ? 'success' : 'error'}>
                  置信度 {Math.round(toNum(d.confidence) * 100)}%
                </Tag>
                <Tag>{customerName(d)}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {d.items?.length ?? 0} 行 · {DRAFT_STATUS_META[d.status]?.label ?? d.status} · {fmtDateTime(d.createdAt)}
                </Typography.Text>
              </Space>
              {d.rawText && (
                <Typography.Paragraph
                  type="secondary"
                  ellipsis={{ rows: 1, expandable: true, symbol: '展开原文' }}
                  style={{ marginBottom: 0, fontSize: 12 }}
                >
                  原文：{d.rawText}
                </Typography.Paragraph>
              )}
              {d.lowConfidence && (
                <Alert type="error" banner message="低置信度，必须逐项人工核对" showIcon={false} />
              )}
              {d.ambiguities?.length ? (
                <Space size={4} wrap>
                  {d.ambiguities.map((a, i) => (
                    <Typography.Text key={i} type="warning" style={{ fontSize: 12 }}>⚠ {a}</Typography.Text>
                  ))}
                </Space>
              ) : null}
            </Space>
          </Card>
        </List.Item>
      )}
    />
  );
}

// ───────────────────────── 编辑抽屉（可编辑红线核心页） ─────────────────────────

interface EditableDraftItem extends DraftItemDTO {
  key: string;
}

function toEditable(items: DraftItemDTO[]): EditableDraftItem[] {
  return (items ?? []).map((i, idx) => ({
    ...i,
    key: `L${idx}-${Math.random().toString(36).slice(2, 8)}`,
    // 单价默认取解析价 hint，可改（保存时落库）
    unitPrice: i.unitPrice ?? i.priceHint ?? null,
  }));
}

function DraftEditDrawer({
  draft, customers, products, onClose, onChanged,
}: {
  draft: OrderDraftDTO | null;
  customers: CustomerDTO[];
  products: ProductDTO[];
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element | null {
  const { message, modal } = AntApp.useApp();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [items, setItems] = useState<EditableDraftItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardReason, setDiscardReason] = useState('');

  useEffect(() => {
    if (!draft) return;
    setCustomerId(draft.customerId ?? undefined);
    setItems(toEditable(draft.items ?? []));
    setDiscardReason('');
  }, [draft]);

  if (!draft) return null;
  // const 别名让守卫收窄进下方闭包（函数式组件闭包不吃参数收窄）
  const d = draft;
  const editable = d.status === 'PENDING_REVIEW';
  const productOptions = products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }));

  function patchItem(key: string, patch: Partial<EditableDraftItem>): void {
    setItems((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const matched = items.filter((i) => i.productId && toNum(i.qty) > 0);
  const totalAmount = matched.reduce((sum, i) => sum + toNum(i.qty) * toNum(i.unitPrice), 0);

  async function save(then?: () => void): Promise<boolean> {
    setSaving(true);
    try {
      await draftsApi.update(d.id, {
        customerId: customerId || undefined,
        items: items.map(({ key, ...rest }) => {
          void key;
          return { ...rest, qty: Number(rest.qty), unitPrice: rest.unitPrice ?? null };
        }),
      });
      message.success(`草稿已保存：${d.draftNo}`);
      onChanged();
      then?.();
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** 确认转单：先存编辑 → 二次确认弹窗（行汇总+总金额）→ 建单（仅 PENDING_CONFIRM，不直接出库） */
  function confirmConvert(): void {
    if (!customerId) {
      message.warning('请先选定客户');
      return;
    }
    if (!matched.length) {
      message.warning('无可转单行：请先为商品行匹配商品（黄色未匹配行不会转单）');
      return;
    }
    const lines = matched.map((i) => ({
      productId: i.productId as string,
      qty: Number(i.qty),
      unit: (i.unit === '瓶' || i.unit === '个' ? 'MIN' : 'BASE') as 'BASE' | 'MIN',
      priceOverride: i.unitPrice ?? undefined,
    }));
    modal.confirm({
      title: `确认转单？${d.draftNo}`,
      width: 560,
      content: (
        <Space direction="vertical" size={6}>
          {matched.map((i) => (
            <Typography.Text key={i.key} style={{ fontSize: 12 }}>
              {i.productName} → {products.find((p) => p.id === i.productId)?.name ?? i.productId}
              ：{toNum(i.qty)} {i.unit} × {fmtMoney(i.unitPrice)} = {fmtMoney(toNum(i.qty) * toNum(i.unitPrice))}
            </Typography.Text>
          ))}
          <Typography.Text strong>合计：{fmtMoney(totalAmount)}（{matched.length} 行）</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            转单后生成「待确认」订单进入订单池，不会直接出库；别名映射将自动学习进词典。
          </Typography.Text>
        </Space>
      ),
      okText: '确认转单',
      cancelText: '再想想',
      onOk: async () => {
        if (!(await save())) throw new Error('保存失败'); // 弹窗保持打开，可重试
        try {
          const res = await draftsApi.confirm(d.id, { customerId, lines, learnAliases: true });
          message.success(`已转单：${res.orderNo}（已进入订单池待确认，不会直接出库）`);
          onChanged();
          onClose();
        } catch (e) {
          message.error(e instanceof Error ? e.message : '转单失败');
          throw e;
        }
      },
    });
  }

  async function doDiscard(): Promise<void> {
    try {
      await draftsApi.discard(d.id, discardReason.trim() || undefined);
      message.success(`草稿已废弃：${d.draftNo}`);
      setDiscardOpen(false);
      onChanged();
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '废弃失败');
      throw e; // onOk 返回拒绝态：弹窗保持打开，可重试
    }
  }

  return (
    <Drawer
      open
      width={760}
      title={`草稿 ${d.draftNo}（${DRAFT_STATUS_META[d.status]?.label ?? d.status}）`}
      onClose={onClose}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Tag color={DRAFT_SOURCE_META[d.source]?.color}>
            {d.source === 'VOICE' ? '语音🎙️' : d.source === 'PHOTO' ? '拍照📷' : '文字📝'}
          </Tag>
          <Tag color={toNum(d.confidence) >= 0.7 ? 'success' : 'error'}>
            置信度 {Math.round(toNum(d.confidence) * 100)}%
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            引擎 {d.engine ?? 'manual'} · {fmtDateTime(d.createdAt)}
          </Typography.Text>
        </Space>

        {d.lowConfidence && editable && (
          <Alert type="error" message="低置信度，必须逐项人工核对" showIcon />
        )}
        {d.ambiguities?.length ? (
          <Alert
            type="warning"
            message="未解析项（需人工处理）"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {d.ambiguities.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            }
            showIcon
          />
        ) : null}

        {d.rawText && (
          <Typography.Paragraph ellipsis={{ rows: 3, expandable: true }} style={{ marginBottom: 0 }}>
            原文：{d.rawText}
          </Typography.Paragraph>
        )}
        {d.photoUrl && (
          <Typography.Paragraph style={{ marginBottom: 0 }} copyable={{ text: d.photoUrl }}>
            照片：<a href={d.photoUrl} target="_blank" rel="noreferrer">{d.photoUrl}</a>
          </Typography.Paragraph>
        )}
        {d.status === 'CONFIRMED' && d.convertedOrderId && (
          <Alert
            type="success"
            message={<span>已转订单：<Typography.Text copyable>{d.convertedOrderId}</Typography.Text>（见订单池）</span>}
            showIcon
          />
        )}

        <div>
          <Typography.Text strong>客户（必选）</Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Select
              style={{ width: 360 }}
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder="选择客户"
              value={customerId}
              disabled={!editable}
              onChange={setCustomerId}
              options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
            />
          </div>
          {d.customerHint && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>解析线索：{d.customerHint}</Typography.Text>
          )}
        </div>

        <div>
          <Typography.Text strong>商品行（未匹配行不转单）</Typography.Text>
          <Table<EditableDraftItem>
            size="small"
            style={{ marginTop: 6 }}
            rowKey="key"
            pagination={false}
            dataSource={items}
            locale={{ emptyText: '无商品行（引擎离线或解析为空，点下方加一行手工填）' }}
            columns={[
              {
                title: '原文品名', dataIndex: 'productName', width: 150,
                render: (_v, r) => (
                  <Input
                    value={r.productName}
                    disabled={!editable}
                    onChange={(e) => patchItem(r.key, { productName: e.target.value })}
                  />
                ),
              },
              {
                title: '匹配商品', dataIndex: 'productId',
                render: (_v, r) => (
                  <Space size={4}>
                    <Select
                      style={{ minWidth: 200 }}
                      showSearch
                      allowClear
                      optionFilterProp="label"
                      placeholder="搜索商品"
                      value={r.productId ?? undefined}
                      disabled={!editable}
                      onChange={(v) => patchItem(r.key, { productId: v ?? null })}
                      options={productOptions}
                    />
                    {!r.productId && <Tag color="warning">未匹配</Tag>}
                    {r.productId && r.aliasMatched && <Tag color="processing">别名</Tag>}
                  </Space>
                ),
              },
              {
                title: '数量', dataIndex: 'qty', width: 100,
                render: (_v, r) => (
                  <InputNumber
                    min={0.001}
                    step={1}
                    precision={3}
                    style={{ width: 90 }}
                    value={toNum(r.qty)}
                    disabled={!editable}
                    onChange={(v) => patchItem(r.key, { qty: v ?? 0 })}
                  />
                ),
              },
              {
                title: '单位', dataIndex: 'unit', width: 80,
                render: (_v, r) => (
                  <Select
                    style={{ width: 68 }}
                    value={r.unit || '箱'}
                    disabled={!editable}
                    onChange={(v) => patchItem(r.key, { unit: v })}
                    options={UNIT_OPTIONS}
                  />
                ),
              },
              {
                title: '单价', dataIndex: 'unitPrice', width: 120,
                render: (_v, r) => (
                  <InputNumber
                    min={0}
                    precision={2}
                    style={{ width: 110 }}
                    prefix="¥"
                    value={r.unitPrice === null || r.unitPrice === undefined ? undefined : toNum(r.unitPrice)}
                    disabled={!editable}
                    onChange={(v) => patchItem(r.key, { unitPrice: v ?? null })}
                  />
                ),
              },
              {
                title: '金额', width: 110, align: 'right' as const,
                render: (_v, r) => fmtMoney(toNum(r.qty) * toNum(r.unitPrice)),
              },
              ...(editable
                ? [{
                    title: '', width: 70,
                    render: (_v: unknown, r: EditableDraftItem) => (
                      <Button type="text" danger onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}>
                        删除
                      </Button>
                    ),
                  }]
                : []),
            ]}
          />
          {editable && (
            <Space style={{ marginTop: 8 }} wrap>
              <Button
                onClick={() => setItems((prev) => [...prev, {
                  key: Math.random().toString(36).slice(2), productName: '', productId: null, qty: 1, unit: '箱', unitPrice: null,
                }])}
              >
                + 加一行
              </Button>
              <Typography.Text strong>已匹配合计：{fmtMoney(totalAmount)}（{matched.length}/{items.length} 行）</Typography.Text>
            </Space>
          )}
        </div>

        {editable && (
          <Space wrap>
            <Button loading={saving} onClick={() => { void save(); }}>保存草稿</Button>
            <Button type="primary" onClick={confirmConvert}>确认转单</Button>
            <Button danger onClick={() => setDiscardOpen(true)}>废弃</Button>
          </Space>
        )}

        <Modal
          open={discardOpen}
          title={`废弃草稿 ${d.draftNo}`}
          okText="废弃"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onOk={() => doDiscard()}
          onCancel={() => setDiscardOpen(false)}
        >
          <Typography.Paragraph type="secondary">
            废弃后不可转单（仅待确认草稿可废弃）。可填原因，选填。
          </Typography.Paragraph>
          <Input.TextArea
            rows={2}
            maxLength={100}
            showCount
            placeholder="废弃原因（选填）"
            value={discardReason}
            onChange={(e) => setDiscardReason(e.target.value)}
          />
        </Modal>
      </Space>
    </Drawer>
  );
}

// ───────────────────────── 新建草稿（文字粘贴 / 语音 / 拍照 三来源 Tab） ─────────────────────────

const CREATE_TAB_ITEMS: Array<{ key: DraftSourceDTO; label: string }> = [
  { key: 'TEXT', label: '文字粘贴' },
  { key: 'VOICE', label: '语音' },
  { key: 'PHOTO', label: '拍照' },
];

function CreateDraftModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (d: OrderDraftDTO) => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [tab, setTab] = useState<DraftSourceDTO>('TEXT');
  const [text, setText] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [listening, setListening] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const srRef = useRef<SrInstance | null>(null);
  const srCtor = getSpeechRecognition();

  useEffect(() => {
    if (!open) return;
    setTab('TEXT');
    setText('');
    setPhotoUrl('');
  }, [open]);

  // 关弹窗/卸载时停止录音
  useEffect(() => () => { srRef.current?.stop(); }, []);

  function startListen(): void {
    if (!srCtor || listening) return;
    const sr = new srCtor();
    sr.lang = 'zh-CN';
    sr.continuous = true;
    sr.interimResults = false;
    sr.onresult = (e) => {
      let chunk = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal && r[0]?.transcript) chunk += r[0].transcript;
      }
      if (chunk) setText((prev) => (prev ? `${prev} ${chunk.trim()}` : chunk.trim()));
    };
    sr.onerror = () => setListening(false);
    sr.onend = () => setListening(false);
    srRef.current = sr;
    sr.start();
    setListening(true);
  }

  function stopListen(): void {
    srRef.current?.stop();
    setListening(false);
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    const trimmed = text.trim();
    if (tab !== 'PHOTO' && !trimmed) {
      message.warning(tab === 'VOICE' ? '请先录音转写或手输报单内容' : '请粘贴报单文字');
      return;
    }
    if (tab === 'PHOTO' && !trimmed && !photoUrl.trim()) {
      message.warning('照片与文字至少填一项（照片留空时必须配文字）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await draftsApi.create({
        source: tab,
        text: trimmed || undefined,
        photoUrl: tab === 'PHOTO' ? photoUrl.trim() || undefined : undefined,
      });
      message.success(`草稿已创建：${res.draftNo}${res.lowConfidence ? '（低置信度，请逐项核对）' : ''}`);
      onCreated(res);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建草稿失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="新建草稿（语音 / 拍照 / 文字）"
      okText="创建草稿"
      cancelText="取消"
      width={680}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={() => { stopListen(); onClose(); }}
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Tabs
          activeKey={tab}
          onChange={(k) => { stopListen(); setTab(k as DraftSourceDTO); }}
          items={CREATE_TAB_ITEMS.map((t) => ({ key: t.key, label: t.label }))}
        />

        {tab === 'PHOTO' && (
          <>
            <Input
              placeholder="照片 URL（对象存储上传后续接入，试点可手填或留空）"
              value={photoUrl}
              onChange={(e) => setPhotoUrl(e.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              OCR 未接入期以人工看图为主，可在下方文字框辅助记录口述内容。
            </Typography.Text>
          </>
        )}

        {tab === 'VOICE' && (
          srCtor ? (
            <Space wrap>
              <Button
                danger={listening}
                type={listening ? 'primary' : 'default'}
                onClick={() => (listening ? stopListen() : startListen())}
              >
                {listening ? '■ 停止录音' : '🎙️ 开始录音（浏览器转写）'}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {listening ? '正在录音，说完点停止，转写自动填入下方文本框' : '仅 Chrome 系浏览器支持，其余请直接手输'}
              </Typography.Text>
            </Space>
          ) : (
            <Alert type="info" message="当前浏览器不支持语音识别，已降级为手输文字（后端引擎解析不受影响）" showIcon />
          )
        )}

        <Input.TextArea
          rows={6}
          maxLength={1000}
          showCount
          placeholder={'报单内容示例：张三店 13800001234 要 泸州老窖特曲 5箱 茅台飞天 2箱 明天送'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          引擎在线时自动解析客户线索/商品行/数量单价；低置信度草稿会打红标，必须逐项人工核对后才可转单。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

// ───────────────────────── 别名词典抽屉（Q13：人工维护 + 确认转单自动学习） ─────────────────────────

const ALIAS_KIND_TABS: Array<{ key: AliasKindDTO; label: string }> = [
  { key: 'PRODUCT', label: '商品别名' },
  { key: 'CUSTOMER', label: '客户别名' },
];

function AliasDrawer({
  open, onClose, customers, products,
}: {
  open: boolean;
  onClose: () => void;
  customers: CustomerDTO[];
  products: ProductDTO[];
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [kind, setKind] = useState<AliasKindDTO>('PRODUCT');
  const [entries, setEntries] = useState<AliasEntryDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newTarget, setNewTarget] = useState<string>();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    aliasesApi.list(kind)
      .then((r) => { if (alive) setEntries(r); })
      .catch((e) => { if (alive) message.error(e instanceof Error ? e.message : '加载词典失败'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, kind, message]);

  // 切 Tab 清空新增表单
  useEffect(() => {
    setNewKey('');
    setNewTarget(undefined);
  }, [kind]);

  const targetOptions = kind === 'PRODUCT'
    ? products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))
    : customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }));
  const targetName = (targetId: string): string =>
    (kind === 'PRODUCT'
      ? products.find((p) => p.id === targetId)?.name
      : customers.find((c) => c.id === targetId)?.name
    ) ?? `目标 ${targetId.slice(0, 8)}…`;

  async function add(): Promise<void> {
    if (adding) return;
    if (newKey.trim().length < 2) {
      message.warning('别名至少 2 个字符（如「特曲」「老张」或手机号）');
      return;
    }
    if (!newTarget) {
      message.warning(kind === 'PRODUCT' ? '请选择目标商品' : '请选择目标客户');
      return;
    }
    setAdding(true);
    try {
      await aliasesApi.add({ kind, key: newKey.trim(), targetId: newTarget });
      message.success('别名已加入词典（小写规范化）');
      setNewKey('');
      setNewTarget(undefined);
      const r = await aliasesApi.list(kind);
      setEntries(r);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '添加失败');
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await aliasesApi.remove(id);
      setEntries((prev) => prev.filter((x) => x.id !== id));
      message.success('已删除');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  }

  return (
    <Drawer open={open} width={560} title="别名词典" onClose={onClose} destroyOnClose>
      <Tabs
        activeKey={kind}
        onChange={(k) => setKind(k as AliasKindDTO)}
        items={ALIAS_KIND_TABS.map((t) => ({ key: t.key, label: t.label }))}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          style={{ width: 200 }}
          placeholder={kind === 'PRODUCT' ? '别名/简称（如 特曲）' : '电话/简称（如 13800001234）'}
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <Select
          style={{ width: 220 }}
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder={kind === 'PRODUCT' ? '目标商品' : '目标客户'}
          value={newTarget}
          onChange={setNewTarget}
          options={targetOptions}
        />
        <Button type="primary" loading={adding} onClick={() => { void add(); }}>新增</Button>
      </Space>
      <Table<AliasEntryDTO>
        size="small"
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10, size: 'small' }}
        dataSource={entries}
        locale={{ emptyText: '词典为空（确认转单时人工匹配会自动学习进来）' }}
        columns={[
          { title: '别名', dataIndex: 'key', render: (v) => <Typography.Text copyable>{v}</Typography.Text> },
          { title: '目标', dataIndex: 'targetId', ellipsis: true, render: (v) => targetName(v) },
          {
            title: '来源', dataIndex: 'source', width: 100,
            render: (v) => (v === 'AUTO_LEARNED' ? <Tag color="processing">自动学习</Tag> : <Tag>人工</Tag>),
          },
          { title: '命中', dataIndex: 'hitCount', width: 70, align: 'right' as const },
          {
            title: '', width: 70,
            render: (_v, r) => (
              <Popconfirm title="删除该别名？" okText="删除" cancelText="取消" onConfirm={() => { void remove(r.id); }}>
                <Button type="link" size="small" style={{ padding: 0 }} danger>删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        商品别名用于报单文本匹配商品；客户别名（电话/简称）用于来电反查自动填客户。
      </Typography.Text>
    </Drawer>
  );
}
