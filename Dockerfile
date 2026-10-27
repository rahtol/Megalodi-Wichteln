FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm install
COPY client client
COPY server server
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm install --omit=dev
COPY --from=build /app/client/dist client/dist
COPY --from=build /app/server/dist server/dist
EXPOSE 3000
CMD ["npm", "start"]
