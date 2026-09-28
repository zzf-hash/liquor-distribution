import { Injectable, Logger } from '@nestjs/common';

// ═══════════════ P1-T12 解析引擎: 本地 qwen3.8-27b (vLLM OpenAI 兼容接口) ═══════════
// 密钥红线: 只从环境变量读(QWEN_BASE_URL/QWEN_MODEL/QWEN_API_KEY), 不进代码不入库
// 降级: 引擎不可用/超时 → 抛错由上层走「人工兜底」(Q13: 人工兜底为默认路径, 业务不断)
export interface ParsedDraft {
  customerHint: string | null;
  items: Array<{ productName: string; qty: number; unit: string; priceHint: number | null }>;
  confidence: number;
  ambiguities: string[];
}

const SYSTEM_PROMPT = `你是酒水订货单解析器。把口语/微信文本订单解析成结构化 JSON。
规则:
1. 只输出一个 JSON 对象, 不要任何解释文字。
2. items 数组: 每项 {productName, qty, unit, priceHint}——productName 用文本原词(含别名/简称, 不要自行规范化), qty 数字, unit 取 "箱"/"件"=BASE 或 "瓶"/"个"=MIN 的原文, priceHint 文本明确给了价就填数字否则 null。
3. customerHint: 文本中出现的店名/人名/电话线索, 没有则 null。
4. confidence: 0-1, 你对解析完整性的把握(数量/单位含糊、错别字多就调低)。
5. ambiguities: 无法确定的项逐一列出(如"两件一件不明确""品名疑似但不确定")。
6. 口语容错: "老价格/原价"→priceHint=null(系统取专属价); 量词"几个/几件"若是具体数字就用数字。
输出示例: {"customerHint":"张三烟酒店","items":[{"productName":"茅台","qty":2,"unit":"箱","priceHint":null}],"confidence":0.85,"ambiguities":[]}`;

@Injectable()
export class QwenEngineService {
  private readonly logger = new Logger('QwenEngine');

  private cfg(): { base: string; model: string; key: string } {
    return {
      base: process.env.QWEN_BASE_URL || 'http://127.0.0.1:18020/v1',
      model: process.env.QWEN_MODEL || 'qwen3.8-27b',
      key: process.env.QWEN_API_KEY || '',
    };
  }

  async available(): Promise<boolean> {
    const { base, key } = this.cfg();
    try {
      const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 解析文本 → 结构化草稿; 失败抛错(上层人工兜底) */
  async parse(text: string): Promise<ParsedDraft> {
    const { base, model, key } = this.cfg();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `订单文本:\n${text}` },
        ],
        temperature: 0.1,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`qwen engine HTTP ${res.status}`);
    const out = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = out.choices?.[0]?.message?.content ?? '';
    const jsonText = content.includes('```') ? content.split('```')[1]?.replace(/^json\s*/, '') ?? content : content;
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('qwen engine 无有效 JSON 输出');
    const parsed = JSON.parse(jsonText.slice(start, end + 1)) as ParsedDraft;
    if (!Array.isArray(parsed.items)) throw new Error('qwen engine 输出缺 items');
    this.logger.log(`parsed ${parsed.items.length} items, confidence=${parsed.confidence}`);
    return {
      customerHint: parsed.customerHint ?? null,
      items: parsed.items.filter((i) => i.productName && Number(i.qty) > 0),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [],
    };
  }
}
