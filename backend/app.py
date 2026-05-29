import os
import re
import time
import base64
from flask import Flask, request, jsonify
from flask_cors import CORS
import mammoth
import requests
from github import Github
from bs4 import BeautifulSoup

# NOTE:
# `server.ts` is the authoritative backend for authentication, sessions, and
# production API behavior in this repository. This Flask app is retained as a
# utility/reference backend and should not be used as the auth source of truth.

app = Flask(__name__)
CORS(app)

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})

def simple_html_to_asciidoc(html):
    """
    Programmatic transformation from HTML to AsciiDoc using Regex and BeautifulSoup.
    """
    if not html:
        return ""
    
    # Use BeautifulSoup to clean up and structure if needed
    soup = BeautifulSoup(html, 'html.parser')
    
    # Basic replacements
    adoc = str(soup)

    # Headings
    adoc = re.sub(r'<h1[^>]*>(.*?)</h1>', r'\n= \1\n', adoc, flags=re.IGNORECASE | re.DOTALL)
    adoc = re.sub(r'<h2[^>]*>(.*?)</h2>', r'\n== \1\n', adoc, flags=re.IGNORECASE | re.DOTALL)
    adoc = re.sub(r'<h3[^>]*>(.*?)</h3>', r'\n=== \1\n', adoc, flags=re.IGNORECASE | re.DOTALL)
    adoc = re.sub(r'<h4[^>]*>(.*?)</h4>', r'\n==== \1\n', adoc, flags=re.IGNORECASE | re.DOTALL)

    # Bold/Italic
    adoc = re.sub(r'<(b|strong)[^>]*>(.*?)</\1>', r'*\2*', adoc, flags=re.IGNORECASE | re.DOTALL)
    adoc = re.sub(r'<(i|em)[^>]*>(.*?)</\1>', r'_\2_', adoc, flags=re.IGNORECASE | re.DOTALL)

    # Lists
    # First handle list items to add the asterisk
    adoc = re.sub(r'<li[^>]*>(.*?)</li>', r'* \1\n', adoc, flags=re.IGNORECASE | re.DOTALL)
    # Then remove ul/ol tags
    adoc = re.sub(r'<(ul|ol)[^>]*>', r'\n', adoc, flags=re.IGNORECASE | re.DOTALL)
    adoc = re.sub(r'</(ul|ol)>', r'\n', adoc, flags=re.IGNORECASE | re.DOTALL)

    # Paragraphs
    adoc = re.sub(r'<p[^>]*>(.*?)</p>', r'\n\1\n', adoc, flags=re.IGNORECASE | re.DOTALL)

    # Links
    adoc = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', r'link:\1[\2]', adoc, flags=re.IGNORECASE | re.DOTALL)

    # Br
    adoc = re.sub(r'<br\s*/?>', r' +\n', adoc, flags=re.IGNORECASE | re.DOTALL)

    # Clean up entities
    adoc = adoc.replace('&nbsp;', ' ')
    adoc = adoc.replace('&amp;', '&')
    adoc = adoc.replace('&lt;', '<')
    adoc = adoc.replace('&gt;', '>')

    # Remove remaining HTML tags
    adoc = re.sub(r'<[^>]*>', '', adoc)

    # Clean up multiple newlines
    adoc = re.sub(r'\n\s*\n\s*\n', '\n\n', adoc)
    
    return adoc.strip()

from docx import Document

def extract_structured_data(file_path_or_stream):
    """
    Rich structural extraction using python-docx.
    """
    try:
        doc = Document(file_path_or_stream)
        elements = []
        
        for para in doc.paragraphs:
            style = para.style.name.lower()
            text = para.text.strip()
            
            if not text:
                continue

            element_type = "paragraph"
            if "heading 1" in style or style == "heading":
                element_type = "h1"
            elif "heading 2" in style:
                element_type = "h2"
            elif "heading 3" in style:
                element_type = "h3"
            elif "list" in style or para._element.xpath('./w:pPr/w:numPr'):
                element_type = "bullet"
            
            elements.append({
                "type": element_type,
                "content": text,
                "style": style
            })
            
        return elements
    except Exception as e:
        print(f"Extraction error: {e}")
        return []

@app.route('/api/extract-structured', methods=['POST'])
def extract_structured():
    if 'file' not in request.files:
        return jsonify({"error": "Missing file"}), 400
    
    file = request.files['file']
    filename = file.filename
    
    try:
        # We need a seekable stream or temporary file for python-docx
        elements = extract_structured_data(file)
        
        return jsonify({
            "title": filename.replace(".docx", ""),
            "elements": elements
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({"error": "Missing file"}), 400
    
    file = request.files['file']
    filename = file.filename
    
    try:
        if filename.endswith('.docx'):
            # Use mammoth to extract HTML (better for formatting preservation)
            result = mammoth.convert_to_html(file)
            content = result.value
        else:
            # Fallback to plain text
            content = file.read().decode('utf-8')

        doc_id = f"local-{int(time.time())}"
        
        return jsonify({
            "docId": doc_id,
            "title": filename,
            "content": content
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/transform', methods=['POST'])
def transform():
    data = request.get_json()
    doc_id = data.get('docId')
    access_token = data.get('accessToken')
    manual_content = data.get('manualContent')
    
    try:
        content_to_transform = manual_content
        title = "Document"

        if not content_to_transform:
            if access_token and doc_id and not doc_id.startswith('local-'):
                # Try to get Google Doc HTML export
                export_url = f"https://www.googleapis.com/drive/v3/files/{doc_id}/export?mimeType=text/html"
                headers = {"Authorization": f"Bearer {access_token}"}
                response = requests.get(export_url, headers=headers)
                if response.status_code == 200:
                    content_to_transform = response.text
                else:
                    # Fallback or error
                    return jsonify({"error": "Failed to fetch Google Doc. Check permissions."}), 400
            elif doc_id and not doc_id.startswith('local-'):
                # Public Doc
                export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=html"
                response = requests.get(export_url)
                if response.status_code == 200:
                    content_to_transform = response.text
                else:
                    return jsonify({"error": "Unable to fetch public document. Is it shared?"}), 400

        if not content_to_transform:
            return jsonify({"error": "No content available to transform"}), 400

        # Transform logic
        if "<" in content_to_transform and ">" in content_to_transform:
            adoc = simple_html_to_asciidoc(content_to_transform)
        else:
            adoc = content_to_transform
            if not adoc.startswith('='):
                adoc = f"= {title}\n\n{adoc}"

        return jsonify({"adoc": adoc, "title": title})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/sync', methods=['POST'])
def sync_to_github():
    data = request.get_json()
    github_token = data.get('githubToken')
    repo_name = data.get('repo')
    branch = data.get('branch', 'main')
    file_path = data.get('path')
    content = data.get('content')
    message = data.get('message', 'docs: update from SUSE DocEngine')

    try:
        g = Github(github_token)
        repo = g.get_repo(repo_name)
        
        try:
            # Update existing file
            contents = repo.get_contents(file_path, ref=branch)
            repo.update_file(contents.path, message, content, contents.sha, branch=branch)
        except:
            # Create new file
            repo.create_file(file_path, message, content, branch=branch)
            
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    # Run on port 5000 internally if used with a proxy, 
    # or port 3000 if running as the main backend.
    app.run(host='0.0.0.0', port=5000)
