import { Global, Injectable, Logger } from '@nestjs/common';
import { createHmac, createHash } from 'node:crypto';

// ═══════════════ C组 M12-1: 腾讯云 ASR 一句话识别 (录音 ≤60s → 文本) ═══════════════
// 零依赖实现 TC3-HMAC-SHA256 签名直调 asr.tencentcloudapi.com(SentenceRecognition),
// 不引 tencentcloud-sdk(体积大); 未配置密钥时明确报错, 前端回退手敲文字(试点期原路径)。
// env: TENCENT_SECRET_ID / TENCENT_SECRET_KEY (语音下单最后一公里: 录音→文本→qwen 解析)

const HOST = 'asr.tencentcloudapi.com';
const SERVICE = 'asr';
const VERSION = '2019-06-14';
const ACTION = 'SentenceRecognition';

@Global()
@Injectable()
export class AsrService {
  private readonly logger = new Logger('Asr');

  private creds(): { secretId: string; secretKey: string } | null {
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    return secretId && secretKey ? { secretId, secretKey } : null;
  }

  isConfigured(): boolean {
    return this.creds() !== null;
  }

  /** 音频 base64(去 dataURL 前缀) → 文本; 失败抛带明确原因的 Error */
  async transcribe(audioBase64: string, format: 'mp3' | 'wav' | 'm4a' | 'aac' = 'mp3'): Promise<{ text: string; requestId?: string }> {
    const creds = this.creds();
    if (!creds) throw new Error('ASR 未配置(TENCENT_SECRET_ID/SECRET_KEY), 请手敲文字提交');
    const data = audioBase64.includes('base64,') ? audioBase64.slice(audioBase64.indexOf('base64,') + 7) : audioBase64;
    if (data.length > 1024 * 1024) throw new Error('音频过大(>1MB base64), 一句话识别上限 60 秒');

    const body = JSON.stringify({
      ProjectId: 0,
      SubServiceType: 2, // 一句话识别
      EngSerViceType: '16k_zh',
      SourceType: 1, // 音频数据直传
      VoiceFormat: format,
      UsrAudioKey: `draft-${Date.now()}`,
      Data: data,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

    // TC3-HMAC-SHA256 签名(腾讯云 API 3.0 标准)
    const hashedPayload = createHash('sha256').update(body).digest('hex');
    const canonicalRequest = [
      'POST', '/', '',
      'content-type:application/json;charset=utf-8', `host:${HOST}`, '',
      'content-type;host', hashedPayload,
    ].join('\n');
    const credentialScope = `${date}/${SERVICE}/tc3_request`;
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const hmac = (key: Buffer | string, msg: string) => createHmac('sha256', key).update(msg).digest();
    const secretDate = hmac(`TC3${creds.secretKey}`, date);
    const secretService = hmac(secretDate, SERVICE);
    const secretSigning = hmac(secretService, 'tc3_request');
    const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${creds.secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;

    const res = await fetch(`https://${HOST}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=utf-8',
        Host: HOST,
        'X-TC-Action': ACTION,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': 'ap-shanghai',
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as { Response?: { Result?: string; Error?: { Code?: string; Message?: string }; RequestId?: string } };
    const r = json.Response;
    if (!r) throw new Error(`ASR 响应异常(HTTP ${res.status})`);
    if (r.Error) {
      this.logger.warn(`ASR ${r.Error.Code}: ${r.Error.Message}`);
      throw new Error(`语音识别失败: ${r.Error.Message ?? r.Error.Code}`);
    }
    const text = (r.Result ?? '').trim();
    if (!text) throw new Error('语音内容为空, 请重新录制或手敲文字');
    return { text, requestId: r.RequestId };
  }
}
