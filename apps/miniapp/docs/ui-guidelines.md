# 移动端 UI 规范清单（apps/miniapp）

任务依据：d0974541（P0 移动端骨架）· 计划书§2.1易用性红线 · §4.1移动选型
工程：Taro 4.2.1 + React 18 + TypeScript + Vite compiler + Sass（designWidth=750）

## 1. 触控规范（红线，验收必查）

| 项 | 规范值 | 实现 |
|---|---|---|
| 任何可点元素最小高度 | ≥44px 物理（=88px 计量） | `$touch-min: 88px`（src/styles/tokens.scss） |
| 关键主操作（首页三入口） | ≥88px 物理（=176px 计量） | `.entry { min-height: 176px }` |
| 最小字号（正文） | ≥15px 物理（=30px 计量） | `$font-sub: 28px` 仅用于辅助说明；操作文案 ≥ `$font-body: 32px` |
| 卡片圆角 | 16px 计量 | `$radius-base` |

- px→rpx：Taro designWidth=750 下样式写 px 自动转 rpx（1px 计量=1rpx；44px 物理≈88rpx）。
- 新页面 PR 自查：全局搜 `min-height`/`height` 低于 88 的可点元素 = 违规。

## 2. 三主入口（客户端，§2.1 硬约束）

客户首页只放三个主入口，按老年用户可读性设计：

1. 语音下单（🎙️）—— P0-02 接 ASR
2. 拍照下单（📷）—— P0-02 接拍照识单
3. 文字下单（📝）—— P0-02 接商品搜索/快速下单

- 禁止在客户首页叠加第二排功能磁贴；营销位放三入口之后（后续里程碑）。
- 首次下单≤3分钟目标：入口直达功能页，不允许中间确认层。

## 3. 视觉令牌（唯一定义点：src/styles/tokens.scss）

| 令牌 | 值 | 用途 |
|---|---|---|
| `$color-primary` | #8b1e24 | 主色（导航栏/主按钮），按下态 `$color-primary-pressed` |
| `$color-bg` | #f7f5f2 | 页面底 |
| `$color-text` / `$color-text-sub` | #2b2422 / #8a7f7a | 主/辅文字 |
| `$gap-base` / `$gap-lg` | 24px / 32px 计量 | 间距 |
| `$font-title/body/sub` | 40/32/28px 计量 | 字阶 |

规则：页面禁止散落颜色/字号魔法值，一律 `@use '../styles/tokens' as *` 引令牌。

## 4. 四端复用开关

- 登录后的角色来自后端 `user.role`，底部导航在 `src/components/RoleTabBar`。
- 页面注册：`src/app.config.ts` 客户和员工页面都注册在同一个包里。
- 编译目标：weapp（微信小程序）+ h5 双通道 `pnpm build:weapp / build:h5`。

## 5. 模拟器/真机验收路径（当前环境缺口）

- 本机（WSL）无微信开发者工具 GUI：weapp 产物以 `dist/app.json` 完整性 + 编译零错为准；
  模拟器/真机预览在 Windows 侧装微信开发者工具后，导入 `apps/miniapp/project.config.json`（appid 当前为 touristappid，正式 appid 由老板申请后替换）。
- h5 通道可直接 `pnpm dev:h5` 浏览器验证。
