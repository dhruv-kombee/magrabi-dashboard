# Multi-stage production container for Magrabi Commerce Intelligence Platform
# Stage 1: Build the React TypeScript frontend
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Minimal Node.js production runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5174

# Install only the dependencies required by the runtime server. The analytics
# service imports google-auth-library at startup, so the final image must carry
# production node_modules rather than only the frontend build output.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy runtime server and built distribution
COPY server/ ./server/
COPY server.js ./
COPY --from=build /app/dist ./dist

# Non-root user for security
USER node

EXPOSE 5174
CMD ["node", "server.js"]
