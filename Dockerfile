# Let The Frame Work - Container Deployment (Supabase PostgreSQL backend)
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

ENV PORT=3000

# Start the application
CMD ["node", "server.js"]
