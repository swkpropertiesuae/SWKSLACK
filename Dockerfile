FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY public public
ENV PORT=3000 DB_FILE=/data/hub.db
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
