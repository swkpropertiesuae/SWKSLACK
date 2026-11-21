FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY public public
ENV PORT=8080 DB_FILE=/data/hub.db
VOLUME /data
EXPOSE 8080
CMD ["node", "--no-warnings", "src/server.js"]
