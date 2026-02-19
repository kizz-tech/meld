use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const DEFAULT_AGENTS_MD_TEMPLATE: &str = r#"# Vault Rules

This file tells the AI agent how to work with your knowledge base.
Edit freely - the agent will follow your rules.

## Structure

Notes are organized in ecosystem folders:

- `zettel/` - atomic notes (one idea per note)
- `para/` - project notes
- `other/` - templates, misc

When creating a new note, always place it in the appropriate folder:
- Most notes go to `zettel/`: `zettel/note-name.md`
- Project-related notes go to `para/`: `para/project-name.md`

## Note format

Each note starts with YAML frontmatter:

```yaml
---
tags: [zettel]
---
```

File names: human-readable with spaces, like in Obsidian (`My Great Idea.md`).

## Methodology

- One note = one idea. If you have multiple ideas, create multiple notes.
- Before creating a note, check if a similar one already exists.
- Use `[[wikilinks]]` to connect related notes.
- Conversation context counts - "record this" means use recent messages.

## Communication

- Keep responses concise.
- Reference notes with [[wikilinks]] instead of copying their content.
- No filler phrases - just help.
"#;

pub const DEFAULT_MELD_HINTS_TEMPLATE: &str = r#"# Navigation
- A user question is not a search query. "Who am I?" -> search for user info, not the literal string.
- Wikilinks [[...]] are a navigation map. Follow them when context is relevant.
- The vault may be multilingual - if a search returns 0 results, retry with translated synonyms and broader terms.

# Tools
- kb_create for new notes, kb_update for existing. kb_create fails if file exists - read first, then decide.
- Before kb_create, do a quick kb_search (or kb_list) when topic overlap is possible to avoid duplicate notes.
- Use the right tool for the task. Creating = kb_create. Finding info = kb_search. Reading a specific note = kb_read.
- If one user message contains multiple independent ideas, split into separate notes (one idea = one note).
- If user says "record this" or "save this", use recent conversation context directly; do not ask "what should I record?".
- Don't search before every action. "5+5" doesn't need kb_search.
"#;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultInfo {
    pub path: String,
    pub file_count: usize,
    pub total_size_bytes: u64,
}

pub fn meld_dir(vault_path: &Path) -> PathBuf {
    let dir = vault_path.join(".meld");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn read_optional_text(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn read_agents_md(vault_path: &Path) -> Option<String> {
    read_optional_text(&vault_path.join("AGENTS.md"))
}

pub fn read_meld_rules(vault_path: &Path) -> Option<String> {
    read_optional_text(&vault_path.join(".meld").join("rules"))
}

pub fn read_meld_hints(vault_path: &Path) -> Option<String> {
    read_optional_text(&vault_path.join(".meld").join("hints"))
}

pub fn read_global_rules() -> Option<String> {
    read_optional_text(&crate::adapters::config::Settings::global_rules_path())
}

pub fn read_global_hints() -> Option<String> {
    read_optional_text(&crate::adapters::config::Settings::global_hints_path())
}

pub fn ensure_vault_initialized(vault_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let meld = vault_path.join(".meld");
    if meld.exists() {
        // Ensure state/ exists even for already-initialized vaults
        std::fs::create_dir_all(meld.join("state")).ok();
        return Ok(());
    }

    std::fs::create_dir_all(&meld)?;
    std::fs::create_dir_all(meld.join("state"))?;

    let templates_dir = crate::adapters::config::Settings::global_templates_dir();
    let defaults_dir = crate::adapters::config::Settings::global_defaults_dir();

    // AGENTS.md — use template if available
    let agents_template = templates_dir.join("agents.md");
    if agents_template.exists() {
        if let Ok(content) = std::fs::read_to_string(&agents_template) {
            std::fs::write(vault_path.join("AGENTS.md"), content)?;
        } else {
            std::fs::write(vault_path.join("AGENTS.md"), DEFAULT_AGENTS_MD_TEMPLATE)?;
        }
    } else {
        std::fs::write(vault_path.join("AGENTS.md"), DEFAULT_AGENTS_MD_TEMPLATE)?;
    }

    // hints — use template if available
    let hints_template = templates_dir.join("hints");
    if hints_template.exists() {
        if let Ok(content) = std::fs::read_to_string(&hints_template) {
            std::fs::write(meld.join("hints"), content)?;
        } else {
            std::fs::write(meld.join("hints"), DEFAULT_MELD_HINTS_TEMPLATE)?;
        }
    } else {
        std::fs::write(meld.join("hints"), DEFAULT_MELD_HINTS_TEMPLATE)?;
    }

    // rules — copy from template if exists (not created by default)
    let rules_template = templates_dir.join("rules");
    if rules_template.exists() {
        if let Ok(content) = std::fs::read_to_string(&rules_template) {
            std::fs::write(meld.join("rules"), content)?;
        }
    }

    // vault config — copy from defaults/settings.toml if exists
    let defaults_settings = defaults_dir.join("settings.toml");
    if defaults_settings.exists() {
        if let Ok(content) = std::fs::read_to_string(&defaults_settings) {
            std::fs::write(meld.join("config.toml"), content)?;
        }
    }

    Ok(())
}

pub fn scan_vault(vault_path: &Path) -> Result<VaultInfo, Box<dyn std::error::Error>> {
    ensure_vault_initialized(vault_path)?;
    let files = list_md_files(vault_path)?;
    let total_size: u64 = files
        .iter()
        .filter_map(|f| std::fs::metadata(f).ok())
        .map(|m| m.len())
        .sum();

    Ok(VaultInfo {
        path: vault_path.to_string_lossy().to_string(),
        file_count: files.len(),
        total_size_bytes: total_size,
    })
}

pub fn list_md_files(vault_path: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut files = Vec::new();

    for entry in WalkDir::new(vault_path)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
    {
        let entry = entry?;
        if entry.file_type().is_file() {
            if let Some(ext) = entry.path().extension() {
                if ext == "md" {
                    files.push(entry.into_path());
                }
            }
        }
    }

    Ok(files)
}

pub fn file_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteVerification {
    pub exists: bool,
    pub bytes: u64,
    pub hash: String,
}

pub fn normalize_note_path(requested_path: &str) -> Result<String, String> {
    let normalized_slashes = requested_path.trim().replace('\\', "/");
    if normalized_slashes.is_empty() {
        return Err("Note path is empty".to_string());
    }

    fn normalize_part(raw_part: &str) -> String {
        raw_part.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    let mut parts: Vec<String> = Vec::new();
    for raw_part in normalized_slashes.split('/') {
        let part = normalize_part(raw_part);
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("Parent directory segments (..) are not allowed".to_string());
        }
        parts.push(part);
    }

    if parts.is_empty() {
        return Err("Note path is empty".to_string());
    }

    let mut path = parts.join("/");
    if !path.to_ascii_lowercase().ends_with(".md") {
        path.push_str(".md");
    }

    Ok(path)
}

pub fn read_note_verification(
    vault_path: &Path,
    relative_path: &str,
) -> Result<NoteVerification, Box<dyn std::error::Error>> {
    let full_path = vault_path.join(relative_path);
    if !full_path.exists() {
        return Ok(NoteVerification {
            exists: false,
            bytes: 0,
            hash: String::new(),
        });
    }

    let content = std::fs::read_to_string(&full_path)?;
    let bytes = std::fs::metadata(&full_path)?.len();
    Ok(NoteVerification {
        exists: true,
        bytes,
        hash: file_hash(&content),
    })
}

pub fn read_note(vault_path: &Path, relative_path: &str) -> Result<String, std::io::Error> {
    std::fs::read_to_string(vault_path.join(relative_path))
}

pub fn write_note(
    vault_path: &Path,
    relative_path: &str,
    content: &str,
) -> Result<(), std::io::Error> {
    let full_path = vault_path.join(relative_path);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(full_path, content)
}

pub fn list_notes(
    vault_path: &Path,
    subfolder: Option<&str>,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let search_path = match subfolder {
        Some(folder) => vault_path.join(folder),
        None => vault_path.to_path_buf(),
    };

    let files = list_md_files(&search_path)?;
    Ok(files
        .iter()
        .filter_map(|f| f.strip_prefix(vault_path).ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_vault_initialized, normalize_note_path, read_agents_md, read_meld_hints,
        read_meld_rules, DEFAULT_AGENTS_MD_TEMPLATE, DEFAULT_MELD_HINTS_TEMPLATE,
    };

    fn temp_vault() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("meld-vault-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn normalize_path_keeps_human_readable_case_and_spaces() {
        let normalized = normalize_note_path("  folder /  Indie   Hacking   Examples  ")
            .expect("normalize path");
        assert_eq!(normalized, "folder/Indie Hacking Examples.md");
    }

    #[test]
    fn ensure_vault_initialized_creates_meld_agents_and_hints_for_fresh_vault() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");

        ensure_vault_initialized(&vault).expect("initialize vault");

        assert!(vault.join("AGENTS.md").exists());
        assert!(vault.join(".meld").join("hints").exists());
        assert!(vault.join(".meld").join("state").is_dir());
        assert!(read_agents_md(&vault).is_some());
        assert!(read_meld_hints(&vault).is_some());

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn ensure_vault_initialized_does_not_overwrite_existing_files_when_meld_exists() {
        let vault = temp_vault();
        std::fs::create_dir_all(vault.join(".meld")).expect("create temp meld dir");
        std::fs::write(vault.join("AGENTS.md"), "# Existing AGENTS\n").expect("write agents");
        std::fs::write(vault.join(".meld").join("hints"), "existing hints").expect("write hints");

        ensure_vault_initialized(&vault).expect("initialize vault");
        assert_eq!(
            read_agents_md(&vault),
            Some("# Existing AGENTS".to_string())
        );
        assert_eq!(read_meld_hints(&vault), Some("existing hints".to_string()));

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn default_templates_include_expected_sections() {
        assert!(DEFAULT_AGENTS_MD_TEMPLATE.contains("# Vault Rules"));
        assert!(DEFAULT_AGENTS_MD_TEMPLATE.contains("## Structure"));
        assert!(DEFAULT_AGENTS_MD_TEMPLATE.contains("## Methodology"));
        assert!(DEFAULT_AGENTS_MD_TEMPLATE.contains("## Communication"));
        assert!(DEFAULT_MELD_HINTS_TEMPLATE.contains("# Navigation"));
        assert!(DEFAULT_MELD_HINTS_TEMPLATE.contains("# Tools"));
    }

    #[test]
    fn still_works_when_agents_is_deleted_after_initialization() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        ensure_vault_initialized(&vault).expect("initialize vault");
        std::fs::remove_file(vault.join("AGENTS.md")).expect("delete agents");

        assert_eq!(read_agents_md(&vault), None);
        assert!(read_meld_hints(&vault).is_some());

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn reads_instruction_files_and_reflects_file_updates() {
        let vault = temp_vault();
        std::fs::create_dir_all(vault.join(".meld")).expect("create temp meld dir");
        std::fs::write(vault.join("AGENTS.md"), "# AGENTS v1").expect("write agents v1");
        std::fs::write(vault.join(".meld").join("rules"), "MUST v1").expect("write rules v1");
        std::fs::write(vault.join(".meld").join("hints"), "SHOULD v1").expect("write hints v1");

        assert_eq!(read_agents_md(&vault), Some("# AGENTS v1".to_string()));
        assert_eq!(read_meld_rules(&vault), Some("MUST v1".to_string()));
        assert_eq!(read_meld_hints(&vault), Some("SHOULD v1".to_string()));

        std::fs::write(vault.join("AGENTS.md"), "# AGENTS v2").expect("write agents v2");
        std::fs::write(vault.join(".meld").join("rules"), "MUST v2").expect("write rules v2");
        std::fs::write(vault.join(".meld").join("hints"), "SHOULD v2").expect("write hints v2");

        assert_eq!(read_agents_md(&vault), Some("# AGENTS v2".to_string()));
        assert_eq!(read_meld_rules(&vault), Some("MUST v2".to_string()));
        assert_eq!(read_meld_hints(&vault), Some("SHOULD v2".to_string()));

        let _ = std::fs::remove_dir_all(vault);
    }
}
