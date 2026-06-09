# Requirements Document

## Project Description (Input)

Close the class of bug where a domain field is silently dropped at the repository ↔ SQLite serialization boundary, so such gaps are caught by the automated test suite rather than only by live (Playwright + real-LLM) verification. Motivated by the `conversation-message-queue` incident: `pendingQueue` was never persisted (no `pending_queue` column; omitted in write-bind and row-read; `.default([])` masked it on read), yet the suite stayed green because consumer tests used hand-rolled in-memory object fakes that never serialized.

Decided two-part approach (both confirmed): (1) migrate consumer-level persistence fakes onto a shared fixture that runs the **real** repos over a **fresh `:memory:` SQLite database per test** (reusing the existing `_createTestDb`/`openStateDb` primitive that applies the production DDL); (2) add a **schema-driven round-trip contract test per repo** that populates a fully-populated fixture from the Zod schema, persists through the real repo, reloads, and asserts deep-equality — the structural backstop for fields no consumer test exercises. A "mock persistence interface + mock↔prod conformance suite" was explicitly rejected (a non-serializing mock cannot reproduce a serialization defect). Scope: generalize across the persistence layer on `main`, independent of the message-queue feature.

## Introduction

This feature hardens Command Center's automated test suite so that defects at the repository ↔ persistent-store serialization boundary — where a domain field is silently dropped on write or reset to its default on read — are caught by the test suite instead of escaping to live verification. It delivers two complementary safeguards: a schema-driven round-trip durability contract for every repository that serializes a domain object to the store, and migration of persistence-dependent consumer tests off in-memory object fakes onto real repositories backed by an isolated temporary store. This is test-infrastructure work; production persistence code changes only where the new tests reveal a genuine gap.

## Boundary Context

- **In scope**: Round-trip durability tests for every repository that serializes a domain object to the persistent store (conversations, sessions, projects, reference documents, notifications, job records); a shared real-store-backed test fixture for the conversation load/mutate seam; migration of persistence-dependent consumer tests off in-memory object fakes; per-test isolation and reset utilities; an explicit, reviewable declaration of any domain fields intentionally not persisted.
- **Out of scope**: A mock persistence interface or a mock-versus-production conformance suite (explicitly rejected — a non-serializing fake cannot reproduce a serialization defect); changes to production persistence behavior beyond fixing gaps the new tests reveal; new product features; the message-queue feature itself (owned by its own spec/branch).
- **Adjacent expectations**: Schema definitions remain the source of truth for domain shapes; the existing temporary-store test primitive and dependency-injection patterns are reused rather than replaced; the project rule against mocking internal modules applies to all new and migrated tests. Decided implementation direction carried into design: a fresh in-memory store per test for isolation.

## Requirements

### Requirement 1: Schema-driven round-trip durability contract

**Objective:** As a Command Center maintainer, I want every persisted domain field verified through a real serialization round-trip derived from its schema, so that a field dropped on write or reset on read fails the test suite instead of silently losing data in production.

#### Acceptance Criteria
1. The round-trip durability contract shall, for each repository that serializes a domain object to the persistent store, persist a fully-populated instance through the real repository, reload it, and assert the reloaded value deep-equals the persisted value.
2. The round-trip durability contract shall populate every field of the repository's domain schema with a non-default value before persisting.
3. If a persisted domain field is dropped, truncated, or reset to its default by the write-then-read cycle, then the round-trip durability contract shall fail and identify the affected field.
4. When a new field is added to a repository's domain schema and the contract cannot derive a non-default value for it, the round-trip durability contract shall fail rather than skip that field.
5. The round-trip durability contract shall cover the conversations, sessions, projects, reference-documents, notifications, and job-records repositories.

### Requirement 2: Intentionally non-persisted fields are explicit

**Objective:** As a Command Center maintainer, I want any domain field that is deliberately not persisted to be declared explicitly, so that the durability contract cannot be silenced by quietly ignoring a field that should have been saved.

#### Acceptance Criteria
1. Where a domain field is intentionally not persisted, the system shall require that field to be declared in an explicit, reviewable list of non-persisted fields for its repository.
2. If a domain field is neither round-tripped nor present in the explicit non-persisted list, then the round-trip durability contract shall fail.
3. The round-trip durability contract shall not fail for a field that is correctly declared as intentionally non-persisted.

### Requirement 3: Consumer tests exercise real serialization

**Objective:** As a Command Center maintainer, I want tests whose correctness depends on persistence to run against real repositories over a real store, so that they exercise production serialization instead of an in-memory fake that cannot reproduce serialization defects.

#### Acceptance Criteria
1. The system shall provide a shared test fixture that backs the conversation load/mutate seam with the real repositories over a temporary store created from the production schema.
2. While a consumer test's correctness depends on persisted state surviving a write-then-read cycle, that test shall use the shared real-store-backed fixture instead of an in-memory object fake.
3. When a domain field is dropped at the serialization boundary, any migrated consumer test that writes and later reads that field shall fail.
4. Where a consumer test only supplies a crafted input state and does not depend on persistence behavior, the system shall permit it to remain on a lightweight fake.

### Requirement 4: Test isolation and determinism

**Objective:** As a Command Center maintainer, I want each persistence-backed test to run against isolated state, so that tests remain deterministic and independent of one another and of the shared application store.

#### Acceptance Criteria
1. The shared test fixture shall provide each test with persistence state isolated from every other test.
2. The system shall provide a reset utility that returns persistence state to empty between tests.
3. When a new table is added to the production schema, the reset utility shall clear it without requiring a manually maintained per-table list.
4. Persistence-backed tests shall not read from or write to the shared application store singleton.
5. The persistence test fixtures shall run fully in-process without requiring external services or network access.

### Requirement 5: Reuse existing primitives and honor the no-internal-mock rule

**Objective:** As a Command Center maintainer, I want the new tests to reuse existing persistence and dependency-injection primitives and to avoid mocking internal modules, so that they exercise real behavior and stay consistent with project engineering principles.

#### Acceptance Criteria
1. The system shall create test stores from the production schema using the existing temporary-store primitive rather than a re-declared schema.
2. New and migrated persistence tests shall not use module-replacement mocking for internal application modules; they shall obtain the real repositories through dependency injection.
3. The round-trip durability contract shall reuse the existing contract-test location and naming convention for repository tests.

### Requirement 6: Suite cost remains acceptable

**Objective:** As a Command Center maintainer, I want the migration to keep the test suite practical to run, so that broader use of a real store does not make the suite prohibitively slow.

#### Acceptance Criteria
1. The persistence test fixtures shall use an in-memory store so that routine test runs do not write to durable disk storage.
2. While migrating consumer tests, the system shall keep the test suite within the existing local and CI feedback expectations, introducing no more than a small, reviewed runtime margin.
