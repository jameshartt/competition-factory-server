# Build stage
FROM node:24-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build application
RUN pnpm build

# Production stage
FROM node:24-alpine

# Install pnpm and curl for health checks
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate && \
    apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./

# Install all dependencies (compression is needed at runtime but listed as devDependency)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy built application from builder
COPY --from=builder /app/build ./build

# Create directories for data storage
RUN mkdir -p /app/data /app/cache && \
    chown -R node:node /app

# Switch to non-root user
USER node

# Expose port
EXPOSE 8383

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:8383/ || exit 1

# Start application
CMD ["node", "build/src/main.js"]
