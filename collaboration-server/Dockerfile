FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./

ENV CANVAS_COLLAB_PORT=17372
ENV CANVAS_COLLAB_DATA_DIR=/app/data
EXPOSE 17372
CMD ["npm", "start"]
