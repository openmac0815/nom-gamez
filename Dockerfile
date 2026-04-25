# Dockerfile for NOM-GAMEZ Backend
# Multi-stage build for smaller image size

# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY nomgamez-backend/package*.json ./
RUN npm install --production

# Copy source code
COPY nomgamez-backend/ ./

# Stage 2: Production
FROM node:18-alpine

WORKDIR /app

# Copy only production dependencies and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/ ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Make sure /app/data is writable (for storage)
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app/data

USER nodejs

# Expose the port the backend runs on (default 3001)
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (res) => {process.exit(res.statusCode === 200 ? 0 : 1)})" || exit 1

# Start the server
CMD ["node", "server.js"]
