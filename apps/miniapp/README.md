# 小程序打包

客户和员工是同一个包。登录后按后端返回的 `user.role` 进入对应首页，底部导航由 `RoleTabBar` 按角色渲染。没有第二套产物，也不再读取 `TARO_APP_ROLE`。

在 `apps/miniapp` 下执行。仓库根目录把命令换成 `pnpm --filter @liquor/miniapp <script>`，或直接：

```bash
pnpm build:miniapp    # weapp dist/ + h5 dist-h5/
pnpm check:bundle     # 检查这两个产物的 js
```

## 构建

不需要设置角色环境变量。

```bash
pnpm build:weapp    # 产物 dist/          （project.config.json 的 miniprogramRoot）
pnpm build:h5       # 产物 dist-h5/
```

`build:weapp:staff` 和 `build:h5:staff` 还在，只是上面两条命令的别名，产物仍是 `dist/` 和 `dist-h5/`。

微信开发者工具打开 `dist/`（里面有 Taro 拷进去的 `project.config.json`，`miniprogramRoot` 是 `./`）。也可以从 `apps/miniapp` 导入，仓库里的 `miniprogramRoot` 指向 `dist/`。

原生 `tabBar` 不写入 `app.json`。微信的 `tabBar.list` 只能有 2–5 个页面，客户页和员工页不是同一组，也放不进 `custom-tab-bar` 的那一份列表。登录后的底部导航是页面里的 `RoleTabBar`。

## 环境变量

只认仓库里实际读取的变量。

| 变量 | 作用 |
| --- | --- |
| `TARO_APP_API_BASE` | 接口前缀。`src/services/api.ts` 和 `config/index.ts` 读取，构建时写成字面量。缺省 `http://127.0.0.1:3000/api`。示例见 `.env.example`。 |

appid 写在 `project.config.json`：`wxc6de50fcfe6fc065`。Taro 构建时把该文件拷进产物，并把 `miniprogramRoot` 改成 `./`。环境变量 `TARO_APP_ID` 若有值，Taro CLI 会用它覆盖产物里的 appid；本仓库没有配置这个变量，所以产物仍是上面的 appid。
