# 金花小馆 · PostgreSQL 联机版

本地娱乐纸牌游戏，包含离线单机、账号注册登录、2～6 人联机、虚拟金币与管理后台。无充值、提现或兑换。

## 启动

需要 Node.js 24 或更新的兼容版本。首次安装执行 `npm ci`；PostgreSQL 使用 `pg` 驱动。当前机器已安装依赖。

```powershell
cd D:\pycharm_project\zhajinhua
node server.mjs
```

打开 <http://localhost:3000>，首次访问创建管理员。没有默认密码。也可以双击 `start.cmd`，或运行 `./Start-Local.ps1`。服务已经运行时无需再次启动。

本地 `.env` 已配置 PostgreSQL，并设为 `HOST=0.0.0.0`，允许其他设备联机。首次管理员仍须从本机 localhost 初始化。`localhost` 与 `127.0.0.1` 的浏览器 Cookie 和本地存档彼此独立，建议始终使用同一地址。

Docker 交互打包、AMD64/ARM64、压缩文件命名和运行配置见 [Docker 部署说明](docs/03-Docker部署.md)。双击 `build-docker.cmd` 即可进入打包向导。

## 本机体验联机

1. 普通浏览器窗口创建管理员或登录一个账号。
2. 使用另一款浏览器或无痕窗口注册另一个成员账号。普通同浏览器标签页共享登录态，不能模拟两个成员。
3. 创建房间，将 6 位房间码填入另一窗口的“输入房间码”。
4. 两人都点击“准备开局”，倒计时 3 秒后发牌。
5. 管理员从左侧“管理后台”管理成员、调整虚拟金币、查询流水和审计。

注册默认获得 10,000 金币，带入默认 2,000。入座时金币从钱包转入桌上账户；离桌时剩余金币回到钱包。进行中离桌会弃牌，结算后退回剩余金币。

管理员不能对自己的账号调账，可以修改后续新成员的初始金币。调账金额为正数时发放，为负数时扣减，必须填写原因。只能扣减成员钱包中可用的金币。

## 同一局域网体验

```powershell
./Start-Local.ps1 -Lan
```

其他设备打开 `http://服务器的局域网IP:3000`。首个管理员仍需在服务器电脑本地创建。是否可连接还取决于 Windows 防火墙和网络隔离；本项目不会自动修改防火墙。局域网 HTTP 不提供传输加密，限可信本地测试，正式部署需要 HTTPS。

PWA 离线缓存需在 localhost 或 HTTPS 等安全上下文下首次联网加载完成；普通局域网 HTTP 通常不提供 Service Worker。单机存档保存在当前浏览器的 localStorage，与联机资产隔离。浏览器清除网站数据会删除本地练习进度。

## 已实现功能

- 共享纯 JavaScript 规则引擎；全牌型比较、A23 最小、235 无特殊、比牌平局发起者输。
- 单机 1～5 个机器人、轻松/标准难度、暂停继续、本地存档、练习币重置。
- 注册、登录、修改密码、单账号会话替换；首个管理员本机初始化。
- 2～6 人房间、准备倒计时、看牌、跟注、加注、比牌、弃牌、超时弃牌、20 轮强制结算。
- 服务端判定、底牌按用户过滤；SSE 通知配合 HTTP 指令与完整快照重连。
- 钱包/桌上/底池分离、PostgreSQL/SQLite 原子事务、平衡分录、幂等请求、资产核对。
- 管理员发放/扣减资产、禁用/启用成员、密码重置、初始金币设置、异常局退款、操作审计。
- 个人流水与对局记录；服务异常重启后撤销未完成局并退款，已完成局不重复结算。
- 响应式电脑/手机页面、PWA 静态缓存。

## 本地版与生产设计的差异

最初的设计见 `docs/`。当前使用 **原生 JavaScript ES Modules + Node HTTP/SSE + PostgreSQL**，保留 SQLite 作为离线开发和测试后端，没有采用 Vue/NestJS。这不是生产容量已经验证的版本。

本地版默认开放注册、仅管理员/成员两种角色。暂未实现邀请码、多级管理额度、管理员 MFA、房间密码、可配置规则模板、数据库私有牌局字段加密、跨机器备份、多实例运行和生产级限流。联机人数和性能仅按本地功能测试验证，未达到文档中 300 并发的压测目标。后台重置密码使用管理员设置的新密码，暂未实现一次性重置凭证和强制改密。

游戏服务采用单实例协调：PostgreSQL 通过会话级 advisory lock 阻止同一 schema 启动两个游戏服务；SQLite 使用进程锁文件。SQLite 在当前 Node 版本中可能打印 ExperimentalWarning；切换 Node 版本前应重新运行测试。数据库连接失效时 PG 服务退出，重启后执行未完成局退款。

## 数据与停止

- 当前正式数据：PostgreSQL 的 `zhajinhua` 数据库，连接信息保存在 `.env`，应用使用独立的 `zhajinhua_app` 账号。
- 旧 SQLite：`data/game.sqlite` 及 `-wal`、`-shm` 文件保留；当前未用于正式 PG 服务。
- 测试数据与截图：`test-results/`，和正式数据分开。
- 单机存档：浏览器 localStorage 的 `jinhua.practice`。
- 服务锁：`data/game.sqlite.lock`，正常退出自动移除，异常退出后重启会检查并清理失效进程锁。
- 前台启动时按 Ctrl+C 停止。停止会让未完成联机局在下次启动时退款。
- PG 备份需使用 `pg_dump` 等数据库备份工具，复制 `data` 目录不会备份 PG 数据。SQLite 模式则先停服务，再复制整个 `data` 目录，不遗漏 WAL。

如本次由开发工具在后台启动，进程信息保存在 `data/server-process.json`，日志为 `data/server.out.log` / `data/server.err.log`。也可以在 Windows 任务管理器中按对应 PID 停止该 Node 进程；不要批量结束其他 Node 进程。

支持环境变量 `HOST`、`PORT`、`DATABASE_URL`、`DB_PATH`。设置 `DB_PATH` 会强制使用 SQLite，主要用于隔离测试。本机自动加载 `.env`，容器通过运行时环境注入，镜像不包含凭据。HTTPS 反向代理部署时设置 `COOKIE_SECURE=1`，并正确转发 Host、Origin，关闭 SSE 响应缓冲。

## 验证

基础测试无外部依赖：

```powershell
node --test tests/engine.test.mjs tests/server.test.mjs
```

覆盖 22,100 种牌型组合、规则边界、100 场随机合法对局的资产守恒、注册登录、管理员权限、重复请求、底牌隔离、联机结算及服务重启退款。

浏览器测试需要开发依赖 `@playwright/test` 和本机 Microsoft Edge：

```powershell
npm install
node node_modules/@playwright/test/cli.js test
```

浏览器测试使用独立数据库与 3101 端口，覆盖管理员初始化、成员注册、单机、离线缓存、双浏览器联机、管理调账和手机布局。

当前机器的全局 npm 入口有路径异常；如需安装开发依赖，可使用实际 npm CLI：

```powershell
node "D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install
```

游戏运行不依赖该 npm 入口。

PostgreSQL 集成测试：`node scripts/test-postgres.mjs`。测试在独立临时 schema 内创建账号、进行对局并核对资产，完成后只删除该临时 schema，不修改正式 public 数据。
