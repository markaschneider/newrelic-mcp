FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and source
COPY package*.json ./
COPY tsconfig.json ./
COPY src/ ./src/

# Install all dependencies (including dev for build)
RUN npm ci --ignore-scripts

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Expose port (Aptible will set PORT env var)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-8000}/health || exit 1

# Run HTTP server
CMD ["node", "dist/http-server.js"]
