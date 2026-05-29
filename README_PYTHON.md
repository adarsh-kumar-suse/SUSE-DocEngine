# Python Backend for SUSE DocEngine

This sub-project contains the refined Python backend logic for the SUSE DocEngine. It uses **Flask** as the web framework and provides the core document transformation engine.

## Architecture

- **Web Framework**: Flask
- **Document Parsing**: `mammoth` (for .docx to HTML)
- **Transformation Engine**: Custom Regex-based logic in `simple_html_to_asciidoc`
- **Integrations**: 
  - Google Drive/Docs API (via `requests`)
  - GitHub API (via `PyGithub`)
  - BeautifulSoup4 (for HTML sanitization)

## Key Functions

### 1. `simple_html_to_asciidoc(html)`
This is the core "Non-AI" transformation logic. It programmatically maps HTML elements to AsciiDoc syntax:
- `<h1>` -> `=`
- `<b>`/`<strong>` -> `*bold*`
- `<li>` -> `* item`
- `<a>` -> `link:url[text]`
- It also handles character entities and whitespace normalization.

### 2. `/api/upload` (POST)
Handles multipart/form-data file uploads.
- **DOCX**: Uses the `mammoth` library to convert the Word document directly into clean HTML, which is then passed to the transformer.
- **TXT/Other**: Reads as raw UTF-8 text.
- **Returns**: A unique `docId` and the extracted `content`.

### 3. `/api/transform` (POST)
The main pipeline endpoint.
- If a `docId` is provided (local or Google), it fetches the content if not already present in the request.
- It detects if the content is HTML or Plain Text.
- It applies the `simple_html_to_asciidoc` logic to produce a production-ready `.adoc` file.

### 4. `/api/sync` (POST)
Integrates with GitHub to push the resulting AsciiDoc file directly to a repository.
- Uses `PyGithub` to handle authentication and file creation/updates.

## Local Setup

### Prerequisites
- Python 3.9+
- pip

### Steps
1. Navigate to the `backend` folder:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Run the application:
   ```bash
   python app.py
   ```
The backend will be available at `http://localhost:5000`.

## Integration with React
In your React frontend, update your API base URL to point to this Python server. For example, in a local environment:
```typescript
const API_URL = "http://localhost:5000";
```

## Why Python?
Using Python for this backend allows for more robust document manipulation libraries (like `python-docx` or `pandas` for table heavy docs) and provides a cleaner separation of concerns for technical documentation architects.
