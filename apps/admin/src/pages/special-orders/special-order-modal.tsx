import { useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, DatePicker, Input, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd';
import { customersApi, productsApi, specialOrdersApi } from '../../services/api';
import { rememberIdemKey } from '../../services/idempotency';
import type { IdemSlot } from '../../services/idempotency';
import type { CustomerDTO, ProductDTO, SpecialOrderDTO } from '../../services/api';
import { fmtMoney, toNum } from '../../utils/format';

interface SpecialLineDraft {
  key: string;
  productId?: string;
  productName: string;
  unit: string;
  qty?: number;
  price?: number;
}

function newSpecialLine(): SpecialLineDraft {
  return { key: Math.random().toString(36).slice(2), productName: '', unit: '' };
}

export default function CreateSpecialOrderModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { message } = AntApp.useApp();
  const [customers, setCustomers] = useState<CustomerDTO[]>([]);
  const [products, setProducts] = useState<ProductDTO[]>([]);
  const [title, setTitle] = useState('');
  const [customerId, setCustomerId] = useState<string>();
  const [customerName, setCustomerName] = useState('');
  const [isBanquet, setIsBanquet] = useState(false);
  const [eventDate, setEventDate] = useState<string>();
  const [venue, setVenue] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [address, setAddress] = useState('');
  const [deliveryDate, setDeliveryDate] = useState<string>();
  const [payeeName, setPayeeName] = useState('');
  const [payDueDate, setPayDueDate] = useState<string>();
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<SpecialLineDraft[]>([newSpecialLine()]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setCustomerId(undefined);
    setCustomerName('');
    setIsBanquet(false);
    setEventDate(undefined);
    setVenue('');
    setContactName('');
    setContactPhone('');
    setAddress('');
    setDeliveryDate(undefined);
    setPayeeName('');
    setPayDueDate(undefined);
    setNote('');
    setLines([newSpecialLine()]);
    customersApi.list({ page: 1, pageSize: 200, onboarding: 'ACTIVE' })
      .then((r) => setCustomers(r.items))
      .catch(() => setCustomers([]));
    productsApi.list({ page: 1, pageSize: 200, status: 'ON_SALE' })
      .then((r) => setProducts(r.items))
      .catch(() => setProducts([]));
  }, [open]);

  function patchLine(key: string, patch: Partial<SpecialLineDraft>): void {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /** 选中档案客户：名称为空时带出；选品：品名/单位为空时带出 */
  function pickCustomer(id: string): void {
    setCustomerId(id);
    const c = customers.find((x) => x.id === id);
    if (c && !customerName.trim()) setCustomerName(c.name);
  }

  function pickProduct(key: string, productId: string): void {
    const p = products.find((x) => x.id === productId);
    const line = lines.find((l) => l.key === key);
    patchLine(key, {
      productId,
      productName: line && !line.productName.trim() && p ? p.name : line?.productName,
      unit: line && !line.unit.trim() && p ? p.baseUnit : line?.unit,
    });
  }

  const total = lines.reduce((sum, l) => sum + (l.qty ?? 0) * (l.price ?? 0), 0);

  async function submit(): Promise<void> {
    if (!title.trim()) { message.warning('请填写特殊订单标题'); return; }
    if (!customerName.trim()) { message.warning('请填写客户名称（无档案散客直接手填）'); return; }
    if (!contactName.trim() || !contactPhone.trim()) { message.warning('请填写联系人和联系电话'); return; }
    if (!address.trim()) { message.warning('请填写配送地址'); return; }
    if (isBanquet && !eventDate) { message.warning('宴席单请填写宴席日期'); return; }
    const valid = lines.filter((l) => l.productName.trim() && l.qty && l.qty > 0);
    if (valid.length === 0) {
      message.warning('请至少添加一行有效的明细（品名+数量）');
      return;
    }
    setSubmitting(true);
    try {
      const res = await specialOrdersApi.create({
        title: title.trim(),
        customerId: customerId || undefined,
        customerName: customerName.trim(),
        isBanquet,
        eventDate,
        venue: venue.trim() || undefined,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        address: address.trim(),
        deliveryDate,
        payeeName: payeeName.trim() || undefined,
        payDueDate,
        note: note.trim() || undefined,
        lines: valid.map((l) => ({
          productId: l.productId,
          productName: l.productName.trim(),
          unit: l.unit.trim() || '件',
          qty: l.qty as number,
          price: l.price ?? 0,
        })),
      });
      message.success(`特殊订单已创建（草稿）：${res.specialNo}，提交定价审批通过后方可出货`);
      onCreated();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建特殊订单失败');
    } finally {
      setSubmitting(false);
    }
  }

  const dateProps = {
    style: { width: '100%' },
    allowClear: true as const,
  };

  return (
    <Modal
      open={open}
      title="新建特殊订单"
      okText="保存草稿"
      cancelText="取消"
      width={920}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Input style={{ width: 280 }} placeholder="标题（如：张府婚宴用酒）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Select
            style={{ width: 240 }}
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="档案客户（散客可不选）"
            value={customerId}
            onChange={(v) => (v ? pickCustomer(v) : setCustomerId(undefined))}
            options={customers.map((c) => ({ value: c.id, label: `${c.name}（${c.code}）` }))}
          />
          <Input style={{ width: 200 }} placeholder="客户名称（必填，可手填）" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
        </Space>

        <Space wrap align="center">
          <Space size={4}>
            <Typography.Text>婚宴宴席单</Typography.Text>
            <Switch checked={isBanquet} onChange={setIsBanquet} />
          </Space>
          {isBanquet && (
            <>
              <DatePicker {...dateProps} placeholder="宴席日期" onChange={(d) => setEventDate(d ? d.toISOString() : undefined)} />
              <Input style={{ width: 220 }} placeholder="宴席地点（酒店/场地）" value={venue} onChange={(e) => setVenue(e.target.value)} />
            </>
          )}
        </Space>

        <Space wrap>
          <Input style={{ width: 140 }} placeholder="联系人" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          <Input style={{ width: 150 }} placeholder="联系电话" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          <Input style={{ width: 330 }} placeholder="配送地址" value={address} onChange={(e) => setAddress(e.target.value)} />
          <DatePicker {...dateProps} placeholder="配送时间" onChange={(d) => setDeliveryDate(d ? d.toISOString() : undefined)} />
        </Space>

        <Space wrap>
          <Input style={{ width: 160 }} placeholder="收款人（F8）" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} />
          <DatePicker {...dateProps} placeholder="收款截止时间" onChange={(d) => setPayDueDate(d ? d.toISOString() : undefined)} />
        </Space>

        {lines.map((l) => (
          <Space key={l.key} align="center" wrap>
            <Select
              style={{ minWidth: 220 }}
              showSearch
              allowClear
              optionFilterProp="label"
              placeholder="选商品（自由品名可不选）"
              value={l.productId}
              onChange={(v) => (v ? pickProduct(l.key, v) : patchLine(l.key, { productId: undefined }))}
              options={products.map((p) => ({ value: p.id, label: `${p.name}（${p.skuCode}）` }))}
            />
            <Input
              style={{ width: 160 }}
              placeholder="品名（杂酒/赠品组合）"
              value={l.productName}
              onChange={(e) => patchLine(l.key, { productName: e.target.value })}
            />
            <Input
              style={{ width: 90 }}
              placeholder="单位"
              value={l.unit}
              onChange={(e) => patchLine(l.key, { unit: e.target.value })}
            />
            <InputNumber
              min={0.001}
              step={1}
              precision={3}
              style={{ width: 100 }}
              placeholder="数量"
              value={l.qty}
              onChange={(v) => patchLine(l.key, { qty: v ?? undefined })}
            />
            <InputNumber
              min={0}
              precision={2}
              style={{ width: 110 }}
              prefix="¥"
              placeholder="单价"
              value={l.price}
              onChange={(v) => patchLine(l.key, { price: v ?? undefined })}
            />
            <Button
              type="text"
              danger
              disabled={lines.length === 1}
              onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
            >
              删除
            </Button>
          </Space>
        ))}
        <Space>
          <Button onClick={() => setLines((prev) => [...prev, newSpecialLine()])}>+ 加一行</Button>
          <Typography.Text strong>预估合计：{fmtMoney(total)}</Typography.Text>
        </Space>

        <Input.TextArea
          rows={2}
          maxLength={200}
          showCount
          placeholder="备注（客户要求/赠品说明等）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          保存为草稿后需「提交定价审批」，审批通过（APPROVED）才能转正式订单出货；价格以审批口径为准。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
