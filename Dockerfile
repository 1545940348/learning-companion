# CloudBase 云托管部署镜像（说明书 V2.0 · P-C13 前后端同源部署）
#
# 依据腾讯云官方文档「Node.js 快速开始」：
#   https://docs.cloudbase.net/run/quick-start/dockerize-node
#
# 本项目是单仓库（monorepo）：一次构建同时产出服务端与前端，
# 运行阶段由服务端**同源**提供页面与 /api 接口（见 apps/server/src/http/serve-web.ts）。
#
# ⚠️ 云托管创建服务时，端口要填 3000（与下面的 EXPOSE 及 apps/server 的 PORT 默认值一致）。

FROM node:22-alpine

# 时区设为上海（官方建议）。不设的话容器日志比本地早 8 小时，排查问题时极易误判。
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

WORKDIR /app

# 先只拷贝源码（.dockerignore 已排除 node_modules 与 dist），再装依赖、再构建。
COPY . .

# 国内构建改用云厂商 npm 镜像源，速度明显更快（官方建议）。
#
# ⚠️ 这里**必须先丢弃 package-lock.json 再安装**，否则构建一定失败。
# 原因：本仓库的锁文件是在 Windows 上生成的，里面**缺少平台相关的可选依赖**——
#   · rollup 声明了 27 个平台二进制，锁文件里一个都没记；
#   · esbuild 只记了 win32-x64。
# 于是在 Linux 上 `npm install` 认为"已满足"，**永远不会去拉 linux-x64-musl**，
# 随后 tsup / vite 加载 rollup 原生模块时报
# `Cannot find module @rollup/rollup-linux-x64-musl`（npm 已知缺陷 npm/cli#4828）。
#
# 丢掉锁文件后，npm 会**按容器自身的平台（Linux/musl）重新解析**，正确拉取。
# 代价：容器内不再锁定依赖版本，可复现性下降；对演示镜像这个取舍可接受。
# 彻底修法是重新生成一份含全平台可选依赖的锁文件（待办，影响全队在 Linux 上的构建）。
RUN rm -f package-lock.json && \
    npm config set registry https://mirrors.cloud.tencent.com/npm/ && \
    npm install

# 一次构建出两份产物：apps/server/dist（服务端）+ apps/web/dist（前端）
RUN npm run build

EXPOSE 3000

# 与本地 npm start 完全一致：npm run start -w @lc/server → node dist/index.js
CMD ["npm", "start"]
