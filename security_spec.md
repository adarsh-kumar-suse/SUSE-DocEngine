# Security Specification - SUSE DocEngine

## 1. Data Invariants
- `User` documents must have a unique `uid` matching their Firebase Auth UID.
- `PipelineJob` documents must be associated with a valid `googleDocId` and owned by the `userId`.
- `status` field in `PipelineJob` must follow the state machine: pending -> processing -> completed/failed.

## 2. Access Control
- **Users Collection**: Read/Write restricted to `request.auth.uid == userId`.
- **Jobs Collection**: 
  - `create`: Must set `userId` to `request.auth.uid`.
  - `read`: Restricted to `resource.data.userId == request.auth.uid`.
  - `update`: Restricted to owner. Only `status`, `asciiDocContent`, `githubPrUrl`, and `error` can be updated.

## 3. "Dirty Dozen" Payloads (Denial Tests)
1. Creating a job for another user.
2. Updating `userId` of an existing job.
3. Injecting a massive string (>1MB) into `asciiDocContent`.
4. Setting an invalid `status` (e.g., "hacked").
5. Reading another user's job records.
6. Deleting a job without ownership.
7. Updating the `createdAt` timestamp of a job.
8. Bypassing the `isValidId` check for `googleDocId`.
9. Modifying `googleDocId` after creation.
10. Creating a user profile for a different UID.
11. Reading PII of another user.
12. Bulk listing all jobs without being the owner.
