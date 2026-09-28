import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

// ═══════════════ 飞书群机器人通知 (P1-T31 清账通知 / 审批待办 / 异常告警) ═══════════════
// 配置(.env, 均可选; 未配置=功能静默关闭, 不影响业务):
//   FEISHU_WEBHOOK_URL  群自定义机器人 webhook 地址
//   FEISHU_SECRET       签名密钥(机器人开了"签名校验"才填)
// 消息走 text 模板(标题+多行), 失败只告警不阻断业务(通知是旁路)

@Injectable()
export class NotifyService {
  private readonly logger = new Logger('Notify');

  private webhook(): { url: string; secret: string } | null {
    const url = process.env.FEISHU_WEBHOOK_URL;
    if (!url) return null;
    return { url, secret: process.env.FEISHU_SECRET || '' };
  }

  /** 发送通知; 返回是否成功(失败不抛错) */
  async send(title: string, lines: string[]): Promise<boolean> {
    const cfg = this.webhook();
    if (!cfg) return false; // 未配置=静默关闭
    const body: Record<string, unknown> = {
      msg_type: 'text',
      content: { text: `【${title}】\n${lines.join('\n')}` },
    };
    if (cfg.secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const sign = createHmac('sha256', `${timestamp}\n${cfg.secret}`).update('').digest('base64');
      body.timestamp = timestamp;
      body.sign = sign;
    }
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const out = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
      if (!res.ok || (out.code !== undefined && out.code !== 0)) {
        this.logger.warn(`feishu notify failed: HTTP ${res.status} ${out.msg ?? ''}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`feishu notify error: ${String(e).slice(0, 120)}`);
      return false;
    }
  }
}
