FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY catalog ./catalog
COPY scripts ./scripts
ENV NODE_ENV=production DATABASE_PATH=/data/trackbuzz.db
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
