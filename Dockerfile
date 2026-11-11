FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM build AS test
COPY db ./db
COPY public ./public
COPY tsconfig.test.json ./
COPY test ./test
COPY scripts ./scripts
CMD ["npm", "test"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node db ./db
COPY --chown=node:node public ./public
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
