# syntax=docker/dockerfile:1
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# только production-зависимости (ws)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# код приложения (без лишнего — см. .dockerignore)
COPY server ./server
COPY public ./public

EXPOSE 3000

CMD ["npm", "start"]
