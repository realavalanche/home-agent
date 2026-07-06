FROM node:24-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install --no-save typescript tsx

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080

# Apply DB migrations, then run the web server + pg-boss worker/scheduler in one
# always-on process (see src/index.ts).
CMD ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/index.js"]
