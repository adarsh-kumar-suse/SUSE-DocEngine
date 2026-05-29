# Local Deployment Guide for SUSE DocEngine

Follow these steps to run the SUSE DocEngine on your local machine.

## Prerequisites
- Node.js (v18 or higher)
- DAPS installed locally for HTML/PDF rendering
- A Firebase project (or use the one provided in the app)
- A Google Cloud Project for Gemini API (optional, as we just moved to non-AI logic for transformation)

## Steps

### 1. Extract the Project
Download the source code and unzip it to a folder.

### 2. Install Dependencies
Open your terminal in the project root and run:
```bash
npm install
```

For DAPS HTML rendering, the workspace also needs the Asciidoctor DocBook converter package because DAPS renders through the `docbook5` backend:
```bash
npm install @asciidoctor/docbook-converter
```

If `npm install` fails with `EACCES`, fix the ownership of the project `node_modules` directory first, then rerun the install.

### 3. Setup Firebase Config
The application needs the `firebase-applet-config.json` file in the root. Ensure it contains your Firebase project credentials. You can get these from the Firebase Console (Project Settings -> General -> Your apps -> SDK setup and configuration).

**CRITICAL: Authorized Domains**
To make Google Login work locally:
1. Go to [Firebase Console](https://console.firebase.google.com/).
2. Select your project.
3. Go to **Authentication** -> **Settings** -> **Authorized Domains**.
4. Click **Add Domain** and add `localhost` and `127.0.0.1`.
5. Ensure your browser allows popups and doesn't block 3rd party cookies for Google/Firebase domains.

### 4. Setup Environment Variables
Create a `.env` file in the root directory with the following variables:

```env
# Required for any remaining AI features (if any)
GEMINI_API_KEY=your_gemini_api_key

# If you use Firebase Admin SDK features locally
# FIREBASE_PROJECT_ID=...
```

### 5. Google OAuth Setup (For Google Docs Integration)
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project or select existing.
3. Enable "Google Docs API" and "Google Drive API".
4. Setup "OAuth consent screen".
5. Create "OAuth 2.0 Client IDs" (Web application).
6. Add `http://localhost:3000` to "Authorized JavaScript origins".
7. Update the `clientId` in `src/pages/Login.tsx` or where auth is initialized.

### 6. Run the Application
Start the development server:
```bash
npm run dev
```
The app will be available at `http://localhost:3000`.

## Authentication and Sessions
- The backend in `server.ts` is the source of truth for authentication and session handling.
- Session cookies are `HttpOnly` and required for protected `/api/*` endpoints.
- Google login uses Firebase only for identity proof, then exchanges Firebase ID token with `POST /api/auth/google`.
- Local username/email + password auth is available via:
  - `POST /api/auth/signup`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
- A seeded fallback test user is created automatically in local mode:
  - username: `admin`
  - password: `admin123`

## Local-First Storage
The application stores local state in flat files:
- **Jobs & History**: `data/jobs.json`
- **Users**: `data/users.json`
- **Sessions**: `data/sessions.json`
- **Extraction Artifacts**: `data/extractions/*`
- **Collaboration DB (SQLite)**: `data/app.db`

## Collaboration APIs
Session-authenticated collaboration endpoints:
- `GET/POST /api/projects`
- `GET/PATCH/DELETE /api/projects/:projectId`
- `GET /api/projects/:projectId/repo?includeStatus=true`
- `GET /api/projects/:projectId/members`
- `PATCH /api/projects/:projectId/members/:memberUserId`
- `GET/POST /api/projects/:projectId/invites`
- `POST /api/invites/accept`
- `GET/POST /api/projects/:projectId/pipelines`
- `GET/POST /api/projects/:projectId/pipelines/:pipelineId/branches`
- `POST /api/projects/:projectId/pipelines/:pipelineId/working-copy`
- `POST /api/projects/:projectId/pipelines/:pipelineId/publish`
- `GET/POST /api/projects/:projectId/pipelines/:pipelineId/commits`
- `POST /api/projects/:projectId/pipelines/:pipelineId/push`
- `GET /api/projects/:projectId/pipelines/:pipelineId/push-status`
- `GET /api/projects/:projectId/merge-requests`
- `POST /api/projects/:projectId/pipelines/:pipelineId/merge-requests`
- `POST /api/projects/:projectId/merge-requests/:mergeRequestId/approve`
- `POST /api/projects/:projectId/merge-requests/:mergeRequestId/merge`
- `GET /api/projects/:projectId/pipeline-compare` (owner only)
- `GET/POST /api/projects/:projectId/work-items`
- `PATCH /api/projects/:projectId/work-items/:workItemId`
- `GET /api/projects/:projectId/activity`
- `GET /api/projects/:projectId/git-status`
- `POST /api/projects/:projectId/git-sync`

Notes:
- Project creation now requires a repository in `owner/repo` format (prefilled from user Settings).
- Seeded `admin` user has super-admin project access for support operations.

## SMTP Invite Delivery (Optional)
If SMTP is configured, invite emails are sent automatically.
Otherwise invite tokens are still generated and can be used manually.

Add these optional env vars:
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your_gmail_app_password
SMTP_FROM=you@gmail.com
```

## Notes on SUSE Document Transformation
The transformation logic is now local (non-AI) and uses `mammoth` for Docx parsing and custom regex logic in `server.ts` to convert HTML to AsciiDoc.

## OAuth Local Domain Checklist
For stable Google sign-in, ensure all are configured:
1. Firebase Auth Authorized Domains: `localhost`, `127.0.0.1`
2. Google Cloud OAuth JavaScript origins: `http://localhost:3000`, `http://127.0.0.1:3000`
3. Run app locally on same origin (`http://localhost:3000`) via `npm run dev`

## Playwright + Pytest Gates
Install and run local E2E gates from the project `.venv`:
```powershell
.\.venv\Scripts\python.exe -m pip install -U pytest playwright pytest-playwright requests
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe -m pytest e2e/test_smoke.py -q
.\.venv\Scripts\python.exe -m pytest e2e/test_collaboration_api.py -q
```
