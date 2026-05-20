# Cursor prompts — Step 2 reference

Use these in Cursor when extending or debugging the Step 2 skeleton.

---

## Full repo setup (already done)

> You are a senior full-stack architect building a production-grade multi-tenant SaaS monorepo.
>
> Generate a full initial project setup for a system called "bookstore-voice-agents".
>
> Goal: Monorepo for a SaaS that lets admin users create and manage multiple AI voice agents for multiple Shopify bookstores.
>
> Tech stack: pnpm workspaces, Turborepo, Next.js (apps/web), NestJS (apps/api), PostgreSQL, Prisma, Redis, TypeScript.
>
> Requirements: Recommended monorepo folder structure; root package.json, pnpm-workspace.yaml, turbo.json; apps/web and apps/api structure; shared packages; starter Prisma schema; Docker Compose for PostgreSQL and Redis; .env.example; clean scripts for dev/build/lint/typecheck; modular, production-friendly code.

---

## NestJS backend scaffold

> Act as a senior NestJS architect. Generate the initial backend scaffold for apps/api for a multi-tenant SaaS that manages AI voice agents for Shopify stores.
>
> Requirements: NestJS + TypeScript; Modules: health, tenants, users, stores, agents, phone-numbers, prompts, knowledge, calls, transcripts, tools, integrations/shopify, integrations/twilio, integrations/openai, audit-logs; PrismaModule and PrismaService; ConfigModule; global prefix /api; health endpoint; starter controller/service/module for tenants, stores, and agents.

---

## Prisma schema refinement

> Act as a staff backend engineer. Refine the Prisma schema in apps/api/prisma/schema.prisma for production-readiness. Requirements: tenants, users, stores, shopify connections, agents, phone numbers, knowledge documents, prompt versions, call sessions, transcript chunks, tool execution logs, audit logs; soft delete where useful; timestamps; indexing for tenant isolation and query performance; support many stores and many agents per tenant.

---

## Next.js dashboard scaffold

> You are a senior frontend SaaS engineer. Generate the initial Next.js admin dashboard scaffold for bookstore-voice-agents. Requirements: Next.js App Router, TypeScript, Tailwind, shadcn/ui style structure; Pages: /dashboard, /dashboard/stores, /dashboard/agents, /dashboard/calls, /dashboard/analytics, /dashboard/settings; Layout: sidebar, top header, stats cards, recent agents table, recent calls table; clean, premium, B2B SaaS style.

---

## DevOps / local environment

> Act as a senior DevOps engineer. Create the local development setup for a monorepo with Next.js frontend, NestJS backend, PostgreSQL, Redis, Prisma. Requirements: docker-compose for postgres and redis; .env.example; README development instructions; migration commands; seed command placeholder; health check instructions; common troubleshooting notes.
