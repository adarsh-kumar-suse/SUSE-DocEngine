import json
import os
import re
import sys
from typing import Any, Dict, Iterable, List, Optional

import filetype
from docx import Document
from docx.document import Document as _Document
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import _Cell, Table
from docx.text.paragraph import Paragraph

MONO_FONTS = {
    "consolas",
    "courier",
    "courier new",
    "dejavu sans mono",
    "fira code",
    "jetbrains mono",
    "menlo",
    "monaco",
    "source code pro",
}

def iter_block_items(parent: Any) -> Iterable[Any]:
    if isinstance(parent, _Document):
        parent_elm = parent.element.body
    elif isinstance(parent, _Cell):
        parent_elm = parent._tc
    else:
        raise ValueError("Unsupported parent type")

    for child in parent_elm.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, parent)
        elif isinstance(child, CT_Tbl):
            yield Table(child, parent)


def heading_level(style_name: str) -> Optional[int]:
    if not style_name:
        return None

    style = style_name.lower().strip()
    if "title" in style:
        return 1

    m = re.search(r"heading\s*(\d+)", style)
    if m:
        return max(2, min(4, int(m.group(1)) + 1))

    return None


def is_list_paragraph(paragraph: Paragraph, text: str) -> bool:
    style_name = (paragraph.style.name or "").lower()
    has_num_pr = bool(paragraph._element.xpath("./w:pPr/w:numPr"))
    return "list" in style_name or has_num_pr or bool(re.match(r"^\s*(?:[-*]|\d+[.)])\s+", text))


def is_numbered_list(paragraph: Paragraph, text: str) -> bool:
    style_name = (paragraph.style.name or "").lower()
    if "number" in style_name:
        return True
    return bool(re.match(r"^\s*\d+[.)]\s+", text))


def read_numbering_info(paragraph: Paragraph) -> Optional[Dict[str, int]]:
    p_pr = paragraph._p.pPr
    if p_pr is None or p_pr.numPr is None:
        return None

    num_pr = p_pr.numPr
    ilvl = int(num_pr.ilvl.val) if num_pr.ilvl is not None else 0
    num_id = int(num_pr.numId.val) if num_pr.numId is not None else -1
    return {"level": max(0, ilvl), "num_id": num_id}


def read_style_list_level(paragraph: Paragraph) -> int:
    style_name = (paragraph.style.name or "").lower().strip()
    match = re.search(r"list\s+(?:bullet|number)\s*(\d+)", style_name)
    if match:
        return max(0, int(match.group(1)) - 1)
    return 0


def get_list_block_details(paragraph: Paragraph, text: str) -> Optional[Dict[str, Any]]:
    if not is_list_paragraph(paragraph, text):
        return None

    numbering = read_numbering_info(paragraph)
    style_level = read_style_list_level(paragraph)
    list_level = max(numbering["level"], style_level) if numbering else style_level

    block_type = "numbered-item" if is_numbered_list(paragraph, text) else "list-item"
    return {
        "type": block_type,
        "list_level": list_level,
        "num_id": numbering["num_id"] if numbering else None,
    }


def is_code_paragraph(paragraph: Paragraph, text: str) -> bool:
    style_name = (paragraph.style.name or "").lower()
    if any(token in style_name for token in ("code", "source", "preformatted")):
        return True

    monospace_runs = 0
    for run in paragraph.runs:
        font_name = (run.font.name or "").lower().strip()
        if font_name in MONO_FONTS:
            monospace_runs += 1

    if monospace_runs > 0 and monospace_runs >= max(1, len(paragraph.runs) // 2):
        return True

    if text.startswith("    ") or text.startswith("\t"):
        return True

    if "```" in text:
        return True

    return False


def normalize_cell_text(cell: _Cell) -> str:
    parts: List[str] = []
    for p in cell.paragraphs:
        txt = p.text.strip()
        if txt:
            parts.append(txt)
    return "\n".join(parts).strip()


def detect_extension(blob: bytes, default_ext: str = "png") -> str:
    kind = filetype.guess(blob)
    if kind and kind.extension:
        return kind.extension
    return default_ext


def level_label(level: int) -> str:
    return {
        1: "Title",
        2: "Heading",
        3: "Section",
        4: "Subsection",
    }.get(level, "Section")


def media_subfolder_for_extension(extension: str) -> str:
    normalized = (extension or "").lower().strip()
    if normalized == "svg":
        return "svg"
    if normalized in {"jpg", "jpeg", "jpe"}:
        return "jpg"
    return "png"


def get_relationship_id(node: Any) -> Optional[str]:
    for key, value in node.attrib.items():
        if key.endswith("}embed") or key.endswith("}link") or key.endswith("}id"):
            return value
    return None


def collect_paragraph_image_rel_ids(paragraph: Paragraph) -> List[str]:
    rel_ids: List[str] = []
    drawing_nodes = paragraph._element.xpath(".//*[local-name()='blip']")
    for node in drawing_nodes:
        rel_id = get_relationship_id(node)
        if rel_id:
            rel_ids.append(rel_id)

    legacy_nodes = paragraph._element.xpath(".//*[local-name()='imagedata']")
    for node in legacy_nodes:
        rel_id = get_relationship_id(node)
        if rel_id:
            rel_ids.append(rel_id)

    # Preserve order but avoid duplicate image blocks from repeated rel ids in same paragraph.
    return list(dict.fromkeys(rel_ids))


def build_position(section_index: int, block_index: int, source_order: int) -> Dict[str, int]:
    return {
        "section_index": section_index,
        "block_index": block_index,
        "source_order": source_order,
    }


def extract_image_blocks(
    paragraph: Paragraph,
    doc: Document,
    media_root_dir: str,
    media_prefix: str,
    image_counter: List[int],
    section_index: int,
    block_index_start: int,
    source_order: int,
) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []

    block_index = block_index_start

    rel_ids = collect_paragraph_image_rel_ids(paragraph)
    related_parts = getattr(paragraph.part, "related_parts", {}) or {}

    for rel_id in rel_ids:
        image_part = related_parts.get(rel_id) or doc.part.related_parts.get(rel_id)
        if not image_part:
            continue

        image_counter[0] += 1
        blob = image_part.blob
        ext = detect_extension(blob)
        media_subfolder = media_subfolder_for_extension(ext)
        target_dir = os.path.join(media_root_dir, media_subfolder)
        os.makedirs(target_dir, exist_ok=True)
        filename = f"image_{image_counter[0]:03d}.{ext}"
        full_path = os.path.join(target_dir, filename)

        with open(full_path, "wb") as f:
            f.write(blob)

        asset_path = f"{media_prefix}/{media_subfolder}/{filename}".replace("\\", "/")
        blocks.append(
            {
                "type": "image",
                "text": "",
                "caption": f"Image {image_counter[0]}",
                "asset_path": asset_path,
                "media_target_path": asset_path,
                "rows": [],
                "position": build_position(section_index, block_index, source_order),
            }
        )
        block_index += 1

    return blocks


def build_table_block(table: Table, section_index: int, block_index: int, source_order: int) -> Dict[str, Any]:
    rows: List[List[str]] = []
    for row in table.rows:
        rows.append([normalize_cell_text(cell) for cell in row.cells])

    return {
        "type": "table",
        "text": "",
        "asset_path": "",
        "caption": "Table Data",
        "rows": rows,
        "position": build_position(section_index, block_index, source_order),
    }


def build_sections(doc_path: str, media_root_dir: str, media_prefix: str) -> List[Dict[str, Any]]:
    doc = Document(doc_path)
    sections: List[Dict[str, Any]] = []
    current_section: Optional[Dict[str, Any]] = None
    section_counter = 0
    image_counter = [0]
    source_order = 0

    def ensure_section() -> Dict[str, Any]:
        nonlocal current_section, section_counter
        if current_section is None:
            section_counter += 1
            current_section = {
                "section_id": section_counter,
                "order": section_counter,
                "level": 1,
                "levelLabel": level_label(1),
                "subsection_no": str(section_counter),
                "section_no": str(section_counter),
                "heading": "Introduction",
                "content": "",
                "blocks": [],
            }
            sections.append(current_section)
        return current_section

    for block in iter_block_items(doc):
        source_order += 1
        if isinstance(block, Paragraph):
            text = (block.text or "").strip()
            level = heading_level(block.style.name if block.style else "")

            if level and text:
                section_counter += 1
                current_section = {
                    "section_id": section_counter,
                    "order": section_counter,
                    "level": level,
                    "levelLabel": level_label(level),
                    "subsection_no": str(section_counter),
                    "section_no": str(section_counter),
                    "heading": text,
                    "content": text,
                    "blocks": [],
                }
                sections.append(current_section)
                image_blocks = extract_image_blocks(
                    block,
                    doc,
                    media_root_dir,
                    media_prefix,
                    image_counter,
                    len(sections) - 1,
                    len(current_section["blocks"]),
                    source_order,
                )
                if image_blocks:
                    current_section["blocks"].extend(image_blocks)
                continue

            if not text and not block.runs:
                continue

            section = ensure_section()
            section_index = len(sections) - 1

            if text:
                list_details = get_list_block_details(block, text)
                if list_details:
                    block_type = list_details["type"]
                elif is_code_paragraph(block, text):
                    block_type = "code"
                else:
                    block_type = "paragraph"

                content_block: Dict[str, Any] = {
                    "type": block_type,
                    "text": text,
                    "asset_path": "",
                    "caption": "",
                    "rows": [],
                    "position": build_position(section_index, len(section["blocks"]), source_order),
                }
                if block_type == "code":
                    content_block["language"] = "text"
                if list_details:
                    content_block["list_level"] = list_details["list_level"]
                    if list_details["num_id"] is not None:
                        content_block["list_num_id"] = list_details["num_id"]

                section["blocks"].append(content_block)
                section["content"] = (section["content"] + "\n" + text).strip()

            image_blocks = extract_image_blocks(
                block,
                doc,
                media_root_dir,
                media_prefix,
                image_counter,
                section_index,
                len(section["blocks"]),
                source_order,
            )
            if image_blocks:
                section["blocks"].extend(image_blocks)

        elif isinstance(block, Table):
            section = ensure_section()
            section_index = len(sections) - 1
            section["blocks"].append(build_table_block(block, section_index, len(section["blocks"]), source_order))

    return sections


def main() -> int:
    if len(sys.argv) < 4:
        print(
            json.dumps(
                {
                    "error": "Usage: python extract_structured.py <docx_path> <assets_dir> <assets_prefix>"
                }
            ),
            file=sys.stderr,
        )
        return 1

    docx_path = sys.argv[1]
    assets_dir = sys.argv[2]
    assets_prefix = sys.argv[3]

    if not os.path.exists(docx_path):
        print(json.dumps({"error": f"Missing file: {docx_path}"}), file=sys.stderr)
        return 1

    os.makedirs(assets_dir, exist_ok=True)

    try:
        sections = build_sections(docx_path, assets_dir, assets_prefix)
        source_name = os.path.basename(docx_path)
        payload = {
            "app": "SUSE TRD - RC Reference Configurator",
            "source_name": source_name,
            "created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "sections": sections,
        }
        print(json.dumps(payload))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
