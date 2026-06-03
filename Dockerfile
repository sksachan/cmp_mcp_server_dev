FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip python3 bash groff less \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "$TARGETARCH" in \
    amd64) AWS_ARCH="x86_64"; SAM_ARCH="x86_64"; KUBECTL_ARCH="amd64" ;; \
    arm64) AWS_ARCH="aarch64"; SAM_ARCH="arm64"; KUBECTL_ARCH="arm64" ;; \
    *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip; \
  unzip -q /tmp/awscliv2.zip -d /tmp; \
  /tmp/aws/install; \
  rm -rf /tmp/aws /tmp/awscliv2.zip; \
  curl -fsSL "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-${SAM_ARCH}.zip" -o /tmp/aws-sam-cli.zip; \
  unzip -q /tmp/aws-sam-cli.zip -d /tmp/sam-installation; \
  /tmp/sam-installation/install; \
  rm -rf /tmp/sam-installation /tmp/aws-sam-cli.zip; \
  curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${KUBECTL_ARCH}/kubectl" -o /usr/local/bin/kubectl; \
  chmod +x /usr/local/bin/kubectl

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

CMD ["npm", "start"]
