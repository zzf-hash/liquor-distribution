import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

// ═══════════════ 飞书通知(双模式) ═══════════════
// 模式A 应用级(推荐, 功能多): FEISHU_APP_ID+FEISHU_APP_SECRET+FEISHU_CHAT_ID
//   → tenant_access_token 自动管理(缓存+提前刷新), 发群消息/个人消息/卡片
// 模式B 群机器人 webhook(兜底, 零管理): FEISHU_WEBHOOK_URL(+FEISHU_SECRET 签名)
// 两种都未配置 = 静默关闭; 发送失败只告警不阻断业务(通知是旁路)
// env 示例见 .env.example

interface FeishuConfig {
  appId: string;
  appSecret: string;
  chatId: string;
  webhookUrl: string;
  webhookSecret: string;
}

@Injectable()
export class NotifyService {
  private readonly logger = new Logger('Notify');
  private tokenCache: { token: string; expireAt: number } | null = null;

  private cfg(): FeishuConfig {
    return {
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
      chatId: process.env.FEISHU_CHAT_ID || '',
      webhookUrl: process.env.FEISHU_WEBHOOK_URL || '',
      webhookSecret: process.env.FEISHU_SECRET || '',
    };
  }

  private get mode(): 'app' | 'webhook' | 'off' {
    const c = this.cfg();
    if (c.appId && c.appSecret && c.chatId) return 'app';
    if (c.webhookUrl) return 'webhook';
    return 'off';
  }

  // ─────────────── 应用级: tenant_access_token 管理(缓存, 提前 5 分钟刷新) ───────────────
  private async appToken(): Promise<string | null> {
    const c = this.cfg();
    if (this.tokenCache && Date.now() < this.tokenCache.expireAt) return this.tokenCache.token;
    try {
      const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
        signal: AbortSignal.timeout(8000),
      });
      const out = (await res.json()) as { code?: number; tenant_access_token?: string; expire?: number; msg?: string };
      if (out.code !== 0 || !out.tenant_access_token) {
        this.logger.warn(`feishu token failed: ${out.msg ?? res.status}`);
        return null;
      }
      this.tokenCache = { token: out.tenant_access_token, expireAt: Date.now() + ((out.expire ?? 7200) - 300) * 1000 };
      return out.tenant_access_token;
    } catch (e) {
      this.logger.warn(`feishu token error: ${String(e).slice(0, 100)}`);
      return null;
    }
  }

  /** 应用级发消息(im/v1): receiveIdType = chat_id|open_id|union_id|user_id|email */
  private async appSend(receiveIdType: string, receiveId: string, msgType: 'text' | 'interactive', content: unknown): Promise<boolean> {
    const token = await this.appToken();
    if (!token) return false;
    try {
      const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) }),
        signal: AbortSignal.timeout(8000),
      });
      const out = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (out.code !== 0) {
        this.logger.warn(`feishu appSend failed: ${out.code} ${out.msg ?? ''}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`feishu appSend error: ${String(e).slice(0, 100)}`);
      return false;
    }
  }

  // ─────────────── 对外 API ───────────────

  /** 发通知(默认群): 标题+多行文本; 返回是否成功 */
  async send(title: string, lines: string[]): Promise<boolean> {
    const m = this.mode;
    if (m === 'off') return false;
    if (m === 'app') return this.appSend('chat_id', this.cfg().chatId, 'text', { text: `【${title}】\n${lines.join('\n')}` });
    // webhook 模式(含签名)
    const c = this.cfg();
    const body: Record<string, unknown> = { msg_type: 'text', content: { text: `【${title}】\n${lines.join('\n')}` } };
    if (c.webhookSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', `${timestamp}\n${c.webhookSecret}`).update('').digest('base64');
    }
    try {
      const res = await fetch(c.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      const out = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (out.code !== undefined && out.code !== 0)) {
        this.logger.warn(`feishu webhook failed: HTTP ${res.status} ${out.msg ?? ''}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`feishu webhook error: ${String(e).slice(0, 100)}`);
      return false;
    }
  }

  /** 发消息给个人(email 或 open_id)——应用级专属 */
  async sendToUser(receiveId: string, title: string, lines: string[]): Promise<boolean> {
    const idType = receiveId.includes('@') ? 'email' : 'open_id';
    return this.appSend(idType, receiveId, 'text', { text: `【${title}】\n${lines.join('\n')}` });
  }

  /** 卡片消息(默认群)——审批待办等富展示; card 结构见飞书卡片文档 */
  async sendCard(card: Record<string, unknown>): Promise<boolean> {
    if (this.mode !== 'app') return false;
    return this.appSend('chat_id', this.cfg().chatId, 'interactive', card);
  }

  /** 审批待办卡片(标题/字段键值对/高亮按钮文案仅展示——动作回跳后台, 按钮回调需事件订阅后续开) */
  async sendApprovalCard(title: string, fields: Array<[string, string]>, footnote: string): Promise<boolean> {
    return this.sendCard({
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: `审批待办｜${title}` } },
      elements: [
        { tag: 'div', fields: fields.map(([k, v]) => ({ is_short: true, text: { tag: 'lark_md', content: `**${k}**\n${v}` } })) },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: footnote }] },
      ],
    });
  }

  /** 配置自检(部署后验证用) */
  async status(): Promise<{ mode: string; tokenOk?: boolean }> {
    const m = this.mode;
    if (m === 'app') return { mode: m, tokenOk: Boolean(await this.appToken()) };
    return { mode: m };
  }
}
