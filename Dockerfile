FROM node:24-alpine AS dependencies
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/Chunwol/work-automation"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 DATA_DIR=/data TZ=Asia/Seoul
RUN apk add --no-cache tini tzdata && mkdir /data && chown node:node /data
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 3210
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
    CMD node -e "fetch('http://127.0.0.1:3210/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
