FROM node:20

WORKDIR /app

# Copy only package files first for better caching
COPY package.json package-lock.json* ./

RUN npm install

# Copy the rest of the app
COPY . .

# Expose the admin panel port (default 3000)
EXPOSE 3000

CMD ["node", "index.js"]
