FROM node:20

WORKDIR /app

# Copy package files and install dependencies first for better caching
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy the rest of the app
COPY . .

# Expose the admin panel port (default 3000)
EXPOSE 3000

CMD ["node", "index.js"]
CMD ["node", "index.js"]
