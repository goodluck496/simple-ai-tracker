# -------- build stage --------
FROM node:22-alpine AS build

WORKDIR /app

# 1. Copy package files first (layer caching)
COPY package.json package-lock.json* ./

# 2. Install all deps (including dev for Angular build)
RUN npm install

# 3. Copy source
COPY . .

# 4. Build server bundles (esbuild) and Angular web client
RUN npm run build

# -------- runtime stage --------
FROM node:22-alpine AS runtime

WORKDIR /app

# Persist data across container restarts
VOLUME ["/app/data"]

# Copy package + production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy built artifacts from the build stage
COPY --from=build /app/dist ./dist

# Expose HTTP API + UI port
EXPOSE 4317

# Server binds to 0.0.0.0 inside the container so docker port mapping works
ENV SAT_HOST=0.0.0.0

CMD ["node", "dist/server/api.mjs"]
