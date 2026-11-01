# syntax=docker/dockerfile:1.7
# KlovPlay server image: the Rust binary plus the built dashboard (with Playwright's trace viewer).
#
#   docker build -t klovplay .
#
# Behind a TLS-inspecting proxy, pass its CA as a build secret (verification stays on):
#
#   docker build --secret id=extra_ca,src=/path/to/proxy-ca.pem -t klovplay .
#
# The builder uses the same Debian release as the runtime so the binary's glibc matches.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.94-slim-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/playwright-reporter/package.json packages/playwright-reporter/
COPY examples/playwright-demo/package.json examples/playwright-demo/
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
    && pnpm install --frozen-lockfile --filter @klovplay/web...
COPY apps/web apps/web
# The dashboard's generated types import the shared label type from the reporter package.
COPY packages/playwright-reporter/src/generated packages/playwright-reporter/src/generated
RUN pnpm --filter @klovplay/web build

FROM ${RUST_IMAGE} AS server
WORKDIR /src
# Compile-time checked queries use the committed .sqlx data instead of a live database.
ENV SQLX_OFFLINE=true
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY .sqlx .sqlx
COPY migrations migrations
COPY crates crates
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    if [ -f /run/secrets/extra_ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/extra_ca; fi \
    && cargo build --release --locked -p klovplay-server \
    && cp target/release/klovplay-server /usr/local/bin/klovplay-server

FROM ${RUNTIME_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home klovplay
COPY --from=server /usr/local/bin/klovplay-server /usr/local/bin/klovplay-server
COPY --from=web /src/apps/web/dist /app/web
ENV WEB_DIR=/app/web \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info
USER klovplay
EXPOSE 8080
# Migrations run on startup.
ENTRYPOINT ["klovplay-server"]
CMD ["serve"]
