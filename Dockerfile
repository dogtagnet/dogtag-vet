# dogtag-vet web image. Multi-stage build using Next.js standalone output.
#
# Unlike a plain single-package app, this repo is a two-workspace pnpm monorepo (see
# pnpm-workspace.yaml): the vendored protocol/packages/dogtag-standard-ts crypto library is wired
# in as `@dogtag/standard: workspace:*`, so the deps stage needs both package.json files (and the
# workspace manifest) present before `pnpm install` can resolve that link - copying only the root
# package.json, as a single-package image would, fails the install.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY protocol/packages/dogtag-standard-ts/package.json protocol/packages/dogtag-standard-ts/package.json
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/protocol/packages/dogtag-standard-ts/node_modules ./protocol/packages/dogtag-standard-ts/node_modules
COPY . .
# Build-time env: genuinely none needed. The ROAX RPC/chain id/explorer and the five protocol
# contract addresses this app serves to the browser are injected into every page at REQUEST time
# by PublicConfigInitScript (src/components/PublicConfigInitScript.tsx), which reads this
# container's own real runtime env through src/lib/env.ts - never a build-time-inlined
# NEXT_PUBLIC_ literal (WP4.17 D2). This image is built exactly once and the identical artifact is
# deployed to every environment (dev/staging/prod), each supplying its own env at
# `docker run`/Compose/Helm time; see .env.example for what the running container needs.
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# This app ships no public/ directory (no static assets outside what Next itself generates), so
# unlike the usual standalone-output recipe there is nothing to copy from one.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# The two lines below overwrite what the standalone tracer put at these two paths with the real,
# completely-resolved versions from the actual `pnpm install` (the same `deps`/`builder` stage
# node_modules this image already validated by building successfully) rather than trusting the
# tracer for them. See next.config.ts's `outputFileTracingIncludes` comment for why: the vendored
# `@dogtag/standard` package is ESM-only, its dependency graph runs through `circomlibjs` into
# `ethers`, and the standalone tracer resolves none of it - a build that succeeds but a container
# that throws `Cannot find module` the moment any mint or verify route runs. Copying the complete
# trees is simple and unconditionally correct; hand-listing the transitive dependency closure of
# `ethers` in `outputFileTracingIncludes` would not be either. This costs image size (a full
# `node_modules` alongside the already-trimmed standalone one) in exchange for that correctness -
# an explicit, deliberate tradeoff for a self-hosted single-clinic deployment, not an oversight.
# `rm -rf` first: the standalone tracer materialized `node_modules/pdfkit` (and others) as plain
# copied directories in some spots and preserved pnpm's real symlinks in others, and a partial
# `COPY` overlay of the full tree on top of that mismatched shape fails outright (Docker refuses to
# replace a directory with a symlink, or vice versa, at the same path). Clearing both directories
# first and then copying the complete, single-source-of-truth version avoids that entirely.
RUN rm -rf node_modules protocol
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/protocol ./protocol

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
