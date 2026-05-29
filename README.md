# Final SUSE DocEngine

Clean and fresh project copy created from `golu2`.

## What is included
- Frontend + backend source code
- Python extraction backend (`backend/`)
- Templates, references, tests, and scripts

## What is excluded for cleanliness
- `node_modules/`
- build outputs (`dist/`, `build/`, `coverage/`)
- local runtime/cache folders (`__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.venv/`, `venv/`)
- local env/secrets files (`.env`)
- `*.log`, `*.tmp`

## Prerequisites
- Node.js 20+
- npm 10+
- Python 3.10+

## Setup
```bash
npm install
python -m pip install -r backend/requirements.txt
```

## Environment setup
1. Copy `.env.example` to `.env`
2. Fill in real values

## Run locally
```bash
npm run dev
```

App default URL: `http://localhost:3000`

## Useful commands
```bash
npm run lint
npm run build
npm run test:reference-profiles
python -m pytest
npm run check:final-parity
```

## Project structure
- `src/` React UI
- `server.ts` Express API/server
- `backend/` Python extraction utilities
- `common/` shared templates/adoc content
- `references/` partner reference assets
- `tests/` and `e2e/` test suites

## Notes
- This folder is intended as a clean baseline copy for version control and sharing.
- Install dependencies after cloning.
