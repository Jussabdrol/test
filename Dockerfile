# Let The Frame Work - Cloud Run Deployment
# Use official Node.js LTS image
FROM node:20-alpine

# Install dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 8080

# Set environment variable for port (Cloud Run uses 8080)
ENV PORT=8080

# Start the application
CMD ["node", "server.js"]
