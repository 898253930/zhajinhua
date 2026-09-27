# Docker 打包与 PostgreSQL 联机

## Windows 交互打包

双击项目根目录的 `build-docker.cmd`，或在 PowerShell 执行：

```powershell
.\build-docker.cmd
```

向导依次询问 CPU 架构、镜像仓库名、自定义 tag、Node 基础镜像地址、压缩包输出目录，并显示最终配置。AMD/Intel 电脑选 AMD64；ARM 服务器和 Apple Silicon 选 ARM64。这里的 ARM 指 64 位 ARM，不支持 ARMv7。

默认 tag 为 `latest-amd64` 或 `latest-arm64`；输入自定义 tag 后完全按该值使用，不额外拼接架构。

构建结果加载到本机 Docker，然后导出 gzip 压缩镜像和 SHA-256 校验文件，例如：

```text
dist/zhajinhua_v1.2.0_arm64_20260927-231500-123.tar.gz
dist/zhajinhua_v1.2.0_arm64_20260927-231500-123.tar.gz.sha256
```

文件名包含仓库名、tag、架构、**打包开始的本地时间**。仓库名中的 `/`、`:` 替换为 `_`。PowerShell 时间包含毫秒，Bash 精确到秒，均拒绝覆盖已有文件。构建或导出失败不发布完整压缩包；临时文件会清理。Windows 导出时需要同时容纳未压缩 tar 和压缩文件的磁盘空间。

自动化参数示例：

```powershell
.\scripts\build-docker.ps1 -Arch amd64 -Image zhajinhua -Tag v1.2.0-amd64 -NonInteractive
.\scripts\build-docker.ps1 -Arch arm64 -Image zhajinhua -Tag v1.2.0-arm64 -OutputDir D:\images -NonInteractive
```

`-NoExport` 只构建镜像；`-DryRun` 预览命令和文件名；`-NonInteractive` 使用传入值或默认值，不询问输入。

## Docker Hub 拉取超时

已移除 `# syntax=docker/dockerfile:1`，使用 Docker 内置 Dockerfile 前端，避免额外拉取 `docker/dockerfile`。这不会自动修复 Docker Hub 认证地址的网络不可达问题；基础 Node 镜像仍需下载。

脚本与 Dockerfile 现在默认使用已在本机验证可达的 Docker 官方镜像 AWS ECR 发布地址。也可指定自己信任的镜像仓库：

```powershell
.\scripts\build-docker.ps1 -Arch amd64 -Tag v1.2.0-amd64 -BaseImage public.ecr.aws/docker/library/node:24-bookworm-slim -NonInteractive
```

若替代地址也无法访问，需要检查 Docker Desktop 的代理、DNS 或提供可达的仓库地址。脚本不修改系统代理、不自动替换不明第三方源。`npm ci` 还需要访问 package-lock.json 中的依赖下载地址。

参考：[Docker 内置与外部构建前端](https://docs.docker.com/build/buildkit/frontend/)、[Docker 官方镜像的 ECR 列表](https://gallery.ecr.aws/docker/)、[多架构构建](https://docs.docker.com/build/building/multi-platform/)。

## Linux / macOS

```bash
bash scripts/build-docker.sh
bash scripts/build-docker.sh --arch arm64 --tag v1.2.0-arm64 --non-interactive
bash scripts/build-docker.sh --arch amd64 --tag v1.2.0-amd64 --base-image public.ecr.aws/docker/library/node:24-bookworm-slim --non-interactive
```

需要 Docker + Buildx、gzip，以及 sha256sum 或 shasum。依赖安装阶段运行在构建机的架构上；目前 pg 是纯 JavaScript 依赖，目标镜像文件复制不要求执行 ARM 二进制。若在 AMD64 主机运行 ARM64 镜像，则仍需 Docker 的架构模拟支持。

## 导入与启动

Docker 可直接读取 gzip 压缩的镜像归档，无需手动解压：

```powershell
docker load --input .\dist\镜像文件.tar.gz
```

把 `.env.example` 复制为目标机器的私有 `.env`，填写 PostgreSQL 应用账号连接串。本机已有 `.env`，**不要覆盖**。凭据不会打包进镜像，转移压缩包时需单独安全配置运行环境。

```powershell
docker run -d --init --name jinhua --restart unless-stopped -p 3001:3000 --env-file .env -v jinhua-data:/app/data zhajinhua:v1.2.0-amd64
```

注意 `.env` 中 `PORT` 应保持 3000，与容器端口一致。浏览器打开 `http://localhost:3001`；同一网络其他设备访问 `http://游戏服务器IP:3001`。默认监听所有网卡，公网访问还取决于部署主机的公网入口、云安全组及防火墙，数据库服务器 IP 不自动成为游戏网页地址。

**同一个 PostgreSQL schema 只允许一台游戏服务持有协调锁。** 从本地 Node 切换到 Docker 前先停止原服务；不要让本地进程和容器同时连接同一套正式数据。第二个实例会明确拒绝启动。

首次管理员创建只允许服务器本机请求。容器端口映射的浏览器连接不属于容器 loopback，因此用以下命令初始化：

```powershell
docker exec -it jinhua node docker/setup-admin.mjs
```

按提示输入用户名、昵称和密码（隐藏输入），随后在网页正常登录。若数据库已初始化，无需再次创建。

也可在 `.env` 设置 `GAME_IMAGE`、`GAME_ARCH`、`GAME_PORT` 后运行：

```powershell
docker compose up -d
docker compose logs -f
docker compose exec game node docker/setup-admin.mjs
```

## 数据与运行限制

- 设置 `DATABASE_URL` 使用 PostgreSQL；留空则使用 SQLite，持久化目录为 `/app/data`。不要设置 `DB_PATH` 来指向 PG。
- 镜像用非 root 的 node 用户运行。命名卷会继承数据目录权限；自定义绑定目录需确保 UID 1000 可写。
- `.dockerignore` 采用允许列表，仅复制运行代码和依赖定义，不包含 `.env`、本地数据库、测试账号或截图。
- PG 数据保存在数据库服务器，删除容器不会删除 PG 账号和资产。SQLite 模式请保留命名卷。
- 反向代理时使用 HTTPS、转发原 Host/Origin，并关闭 SSE 缓冲；`COOKIE_SECURE=1` 仅用于 HTTPS。
- 日志：`docker logs jinhua`；健康状态：`docker inspect --format '{{.State.Health.Status}}' jinhua`。
