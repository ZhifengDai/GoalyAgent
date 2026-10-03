FROM node:22-alpine

WORKDIR /app

# Copy only what the server needs — no npm install required (zero npm deps)
COPY agent-loop ./agent-loop
COPY apps/insurance_claims ./apps/insurance_claims

# Logs directory must exist and be writable at runtime
RUN mkdir -p apps/insurance_claims/logs

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "apps/insurance_claims/server.ts"]
