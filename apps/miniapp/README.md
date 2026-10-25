# 小程序打包

同一套源码打两个包。区别只有编译期变量 `TARO_APP_ROLE`（`src/config/app-role.ts`）。不设置时是客户包。页面列表两边一样，都在 `src/app.config.ts`。

在 `apps/miniapp` 下执行。仓库根目录把命令换成 `pnpm --filter @liquor/miniapp <script>`。

## 客户包

不设置 `TARO_APP_ROLE`，或设为 `customer`。`app.json` 带原生 tabBar：首页、订货、我的订单、待结金额。

```bash
pnpm build:weapp    # 产物 dist/          （project.config.json 的 miniprogramRoot）
pnpm build:h5       # 产物 dist-h5/
```

## 员工包

`TARO_APP_ROLE=staff`。不写原生 tabBar。业务员、内勤、仓配、老板登录后，底部是页面里的 RoleTabBar。

```bash
pnpm build:weapp:staff    # 产物 dist-staff/
pnpm build:h5:staff       # 产物 dist-h5-staff/
```

微信开发者工具打开对应产物目录（里面有 Taro 拷进去的 `project.config.json`）。客户包也可以从仓库根的 `apps/miniapp` 导入，因为 `miniprogramRoot` 指向 `dist/`。

`salesman`、`clerk`、`warehouse`、`boss` 仍是按单一角色出包，原生 tab 是该角色自己的，不是员工包。

## 环境变量

只认仓库里实际读取的变量。

| 变量 | 作用 |
| --- | --- |
| `TARO_APP_API_BASE` | 接口前缀。`src/services/api.ts` 和 `config/index.ts` 读取。缺省 `http://127.0.0.1:3000/api`。示例见 `.env.example`。 |
| `TARO_APP_ROLE` | `customer`（默认）或 `staff`，以及上面的单角色包。构建时总会编进客户端；不设置或空字符串就是 `customer`。员工包用上面的 `:staff` 脚本。 |

appid 写在 `project.config.json`：`wxc6de50fcfe6fc065`。客户包和员工包共用这一份，仓库里没有第二套 appid。Taro 构建时把该文件拷进产物，并把 `miniprogramRoot` 改成 `./`。环境变量 `TARO_APP_ID` 若有值，Taro CLI 会用它覆盖产物里的 appid；本仓库没有配置这个变量，所以产物仍是上面的 appid。
