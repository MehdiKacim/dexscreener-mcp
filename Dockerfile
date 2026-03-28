WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npx tsc
EXPOSE 10000
ENV PORT=10000
CMD ["node", "dist/index.js", "--http"]