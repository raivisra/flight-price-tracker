FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (disable SSL verification for corporate proxy)
RUN npm config set strict-ssl false && npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Development mode with nodemon
CMD ["npm", "run", "dev"]
