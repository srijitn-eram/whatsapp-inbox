FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN npm --prefix server ci && npm --prefix web ci
COPY . .
RUN npm --prefix web run build && npm --prefix server run build && rm -rf web/node_modules && npm --prefix server prune --omit=dev
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/whatsapp.db
EXPOSE 3000
CMD ["node", "--no-warnings", "server/dist/index.js"]
