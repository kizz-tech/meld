use pulldown_cmark::{Event, Parser, TagEnd};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownChunk {
    pub content: String,
    pub heading_path: Option<String>,
    pub char_start: usize,
    pub char_end: usize,
}

fn strip_frontmatter(markdown: &str) -> &str {
    let lines: Vec<&str> = markdown.lines().collect();
    let content_start = if lines.first() == Some(&"---") {
        lines
            .iter()
            .skip(1)
            .position(|line| *line == "---")
            .map(|pos| {
                lines[..pos + 2]
                    .iter()
                    .map(|line| line.len() + 1)
                    .sum::<usize>()
            })
            .unwrap_or(0)
    } else {
        0
    };
    &markdown[content_start..]
}

pub fn extract_text(markdown: &str) -> String {
    let mut text = String::new();
    let content = strip_frontmatter(markdown);
    let parser = Parser::new(content);

    for event in parser {
        match event {
            Event::Text(t) => {
                text.push_str(&t);
                text.push(' ');
            }
            Event::SoftBreak | Event::HardBreak => {
                text.push('\n');
            }
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Heading(_)) => {
                text.push('\n');
            }
            _ => {}
        }
    }

    text.trim().to_string()
}

fn parse_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let level = trimmed.chars().take_while(|ch| *ch == '#').count();
    if level == 0 || level > 6 {
        return None;
    }

    let title = trimmed[level..].trim();
    if title.is_empty() {
        return None;
    }

    Some((level, title.to_string()))
}

pub fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }

    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= chunk_size {
        return vec![words.join(" ")];
    }

    let mut chunks = Vec::new();
    let mut start = 0;

    while start < words.len() {
        let end = (start + chunk_size).min(words.len());
        let chunk = words[start..end].join(" ");
        chunks.push(chunk);

        if end >= words.len() {
            break;
        }

        start = end - overlap;
    }

    chunks
}

pub fn chunk_markdown(markdown: &str, chunk_size: usize, overlap: usize) -> Vec<MarkdownChunk> {
    let content = strip_frontmatter(markdown);
    if content.trim().is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut heading_stack: Vec<String> = Vec::new();
    let mut section_lines: Vec<String> = Vec::new();
    let mut section_heading: Option<String> = None;
    let mut section_start: usize = 0;
    let mut cursor: usize = 0;

    let flush_section = |chunks: &mut Vec<MarkdownChunk>,
                         section_lines: &mut Vec<String>,
                         section_heading: &Option<String>,
                         section_start: usize| {
        if section_lines.is_empty() {
            return;
        }
        let raw_section = section_lines.join("\n");
        let section_text = extract_text(&raw_section);
        if section_text.trim().is_empty() {
            section_lines.clear();
            return;
        }

        let section_chunks = chunk_text(&section_text, chunk_size, overlap);
        let mut offset = section_start;
        for chunk in section_chunks {
            let chunk_len = chunk.chars().count();
            chunks.push(MarkdownChunk {
                content: chunk,
                heading_path: section_heading.clone(),
                char_start: offset,
                char_end: offset + chunk_len,
            });
            offset += chunk_len;
        }
        section_lines.clear();
    };

    for line in content.lines() {
        if let Some((level, title)) = parse_heading(line) {
            flush_section(
                &mut chunks,
                &mut section_lines,
                &section_heading,
                section_start,
            );

            while heading_stack.len() >= level {
                heading_stack.pop();
            }
            heading_stack.push(title);
            section_heading = Some(heading_stack.join(" > "));
            section_start = cursor + line.len();
        } else {
            section_lines.push(line.to_string());
        }
        cursor += line.len() + 1;
    }

    flush_section(
        &mut chunks,
        &mut section_lines,
        &section_heading,
        section_start,
    );

    if chunks.is_empty() {
        let fallback_text = extract_text(content);
        return chunk_text(&fallback_text, chunk_size, overlap)
            .into_iter()
            .map(|chunk| {
                let chunk_len = chunk.chars().count();
                MarkdownChunk {
                    content: chunk,
                    heading_path: None,
                    char_start: 0,
                    char_end: chunk_len,
                }
            })
            .collect();
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_text_strips_frontmatter() {
        let md = "---\ntags: [test]\n---\n\n# Hello\n\nWorld";
        let text = extract_text(md);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(!text.contains("tags"));
    }

    #[test]
    fn test_chunk_text_basic() {
        let words: Vec<String> = (0..100).map(|i| format!("word{}", i)).collect();
        let text = words.join(" ");
        let chunks = chunk_text(&text, 20, 5);
        assert!(chunks.len() > 1);
        assert!(chunks[0].split_whitespace().count() <= 20);
    }

    #[test]
    fn test_chunk_text_small() {
        let text = "hello world";
        let chunks = chunk_text(text, 512, 50);
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn test_chunk_markdown_tracks_heading_path() {
        let md =
            "# Product\n\nmeld is a knowledge agent.\n\n## Runtime\n\nAgent has lifecycle events.";
        let chunks = chunk_markdown(md, 32, 4);
        assert!(!chunks.is_empty());
        assert!(chunks
            .iter()
            .any(|chunk| chunk.heading_path.as_deref() == Some("Product")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.heading_path.as_deref() == Some("Product > Runtime")));
    }
}
