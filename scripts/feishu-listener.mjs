// 飞书机器人事件监听(长连接模式)——接收私信与群@消息
// 用法: FEISHU_APP_ID/FEISHU_APP_SECRET 环境变量或根目录 apps/api/.env 读取
// 产物: logs/feishu-events.log(消息全文) + 控制台
import larkSDK from '@larksuiteoapi/node-sdk';
const { WSClient, EventDispatcher, lark } = larkSDK;
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'logs'), { recursive: true });
const LOG = join(root, 'logs', 'feishu-events.log');

// 读 apps/api/.env(不入库的密钥文件)
const env = {};
try {
  for (const line of readFileSync(join(root, 'apps/api/.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch { /* .env 缺失则走环境变量 */ }
const APP_ID = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('缺 FEISHU_APP_ID/FEISHU_APP_SECRET');
  process.exit(1);
}

const log = (type, obj) => {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${type} ${JSON.stringify(obj, ensureCircular())}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};
function ensureCircular() { const seen = new WeakSet(); return (k, v) => { if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); } return v; }; }

const dispatcher = new EventDispatcher({}).register({
  // 收到消息(私信 + 群内@机器人)
  'im.message.receive_v1': async (data) => {
    const msg = data.message || {};
    let text = '';
    try { text = JSON.parse(msg.content || '{}').text || msg.content || ''; } catch { text = msg.content || ''; }
    log('MSG', {
      chatType: msg.chat_type, // p2p | group
      chatId: msg.chat_id,
      messageId: msg.message_id,
      msgType: msg.message_type,
      from: (data.sender && data.sender.sender_id) || {},
      text: String(text).slice(0, 500),
    });
    // 自动弱应答(仅 p2p, 告知已收到; 复杂交互后续接 AI)
    if (msg.chat_type === 'p2p' && msg.message_type === 'text') {
      try {
        const client = new larkSDK.Client({ appId: APP_ID, appSecret: APP_SECRET });
        await client.im.message.reply({
          path: { message_id: msg.message_id },
          data: { content: JSON.stringify({ text: '✅ 已收到(本机 Claude 监听中), 消息已入日志。' }), msg_type: 'text' },
        });
      } catch (e) {
        log('REPLY_ERR', { err: String(e).slice(0, 150) });
      }
    }
  },
  'im.message.message_read_v1': async (data) => { log('READ', data); },
});

console.log('飞书长连接启动中...', new Date().toLocaleString('zh-CN'));
const ws = new WSClient({ appId: APP_ID, appSecret: APP_SECRET });
ws.start({ eventDispatcher: dispatcher }).catch((e) => {
  console.error('连接失败:', String(e).slice(0, 200));
  process.exit(1);
});
