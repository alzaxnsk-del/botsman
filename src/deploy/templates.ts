/** Default Dockerfile used when the agent didn't create one (§4 EPIC E). */
export const DEFAULT_DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY . .
USER node
ENV NODE_ENV=production
CMD ["npm", "start"]
`;

/** Files/dirs excluded from the docker build context. */
export const BUILD_IGNORE = ['.git', 'node_modules', '.env'];
