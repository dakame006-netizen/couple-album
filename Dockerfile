FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV ALBUM_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
