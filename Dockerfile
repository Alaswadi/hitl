# Use the official Node.js 20 Alpine lightweight image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Install build dependencies for better-sqlite3 which sometimes needs them on Alpine
RUN apk add --no-cache python3 make g++

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Ensure the data directory exists for SQLite
RUN mkdir -p data

# Expose the application port
EXPOSE 9000

# Start the application
CMD ["npm", "start"]
