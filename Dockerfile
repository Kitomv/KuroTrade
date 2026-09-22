# Trading Dashboard — production image (backend serves the built frontend).
# Build:  docker build -t trading-dashboard .
# Run:    docker run -p 3001:3001 -v trading-data:/app/backend/data trading-dashboard
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package*.json frontend/
RUN npm --prefix frontend ci
COPY frontend frontend
RUN npm --prefix frontend run build

FROM node:20-alpine
WORKDIR /app
COPY backend/package*.json backend/
RUN npm --prefix backend ci --omit=dev
COPY backend backend
COPY --from=build /app/frontend/dist frontend/dist
ENV PORT=3001
EXPOSE 3001
VOLUME ["/app/backend/data"]
CMD ["npm", "--prefix", "backend", "run", "start"]