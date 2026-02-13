# Let The Frame Work - Cloud Run Deployment
# Supports both SQLite (local dev) and PostgreSQL (production)
FROM node:20-alpine

# Install dependencies for better-sqlite3 (needed for local SQLite mode)
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (includes both better-sqlite3 and pg)
RUN npm ci --only=production

# Copy app source
COPY . .

# Create directories for uploads and backups
RUN mkdir -p /app/uploads /app/backups

# Expose port
EXPOSE 8080

# Set environment variables
# PORT: Cloud Run uses 8080
# DB_TYPE: Set to 'postgresql' for Cloud SQL, default 'sqlite' for local
ENV PORT=8080
ENV DB_TYPE=sqlite

# Start the application
CMD ["node", "server.js"]
