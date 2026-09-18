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
# 用 npm install 而非 npm ci：容错优先 —— ci 要求 lockfile 与 package.json 严格同步，
# 不同步会直接中断构建。部署当天卡在这里不划算。
COPY . .

# 国内构建改用云厂商 npm 镜像源，速度明显更快（官方建议）
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ && \
    npm install

# 一次构建出两份产物：apps/server/dist（服务端）+ apps/web/dist（前端）
RUN npm run build

EXPOSE 3000

# 与本地 npm start 完全一致：npm run start -w @lc/server → node dist/index.js
CMD ["npm", "start"]
