use git2::{DiffFormat, IndexEntry, IndexTime, Repository, Signature};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_WALK: usize = 500;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub message: String,
    pub timestamp: i64,
    pub files_changed: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitDiff {
    pub id: String,
    pub message: String,
    pub timestamp: i64,
    pub files_changed: Vec<String>,
    pub patch: String,
}

const MELD_GITIGNORE_ENTRY: &str = ".meld/";

fn meld_git_dir(vault_path: &Path) -> PathBuf {
    vault_path.join(".meld").join(".git")
}

fn ensure_vault_gitignore(vault_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let user_git_dir = vault_path.join(".git");
    if !user_git_dir.exists() {
        return Ok(());
    }

    let gitignore_path = vault_path.join(".gitignore");
    let mut content = if gitignore_path.exists() {
        std::fs::read_to_string(&gitignore_path)?
    } else {
        String::new()
    };

    let already_present = content
        .lines()
        .any(|line| line.trim() == ".meld/" || line.trim() == ".meld");

    if already_present {
        return Ok(());
    }

    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(MELD_GITIGNORE_ENTRY);
    content.push('\n');

    std::fs::write(gitignore_path, content)?;
    Ok(())
}

fn open_or_init_meld_repo(vault_path: &Path) -> Result<Repository, git2::Error> {
    let git_dir = meld_git_dir(vault_path);
    if git_dir.exists() {
        return Repository::open_bare(&git_dir);
    }

    let meld_dir = vault_path.join(".meld");
    std::fs::create_dir_all(&meld_dir)
        .map_err(|e| git2::Error::from_str(&format!("failed to create .meld directory: {e}")))?;

    Repository::init_bare(&git_dir)
}

fn collect_tree_markdown_files(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    prefix: &str,
    out: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), git2::Error> {
    for entry in tree.iter() {
        let Some(name) = entry.name() else {
            continue;
        };
        let relative = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };

        match entry.kind() {
            Some(git2::ObjectType::Tree) => {
                let subtree = repo.find_tree(entry.id())?;
                collect_tree_markdown_files(repo, &subtree, &relative, out)?;
            }
            Some(git2::ObjectType::Blob) => {
                if relative.to_ascii_lowercase().ends_with(".md") {
                    let blob = repo.find_blob(entry.id())?;
                    out.push((relative, blob.content().to_vec()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn apply_tree_snapshot_to_vault(
    repo: &Repository,
    tree: &git2::Tree<'_>,
    vault_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut snapshot_files = Vec::new();
    collect_tree_markdown_files(repo, tree, "", &mut snapshot_files)?;

    let snapshot_paths: HashSet<String> = snapshot_files
        .iter()
        .map(|(relative, _)| relative.clone())
        .collect();

    for existing in crate::adapters::vault::list_md_files(vault_path)? {
        if let Ok(relative) = existing.strip_prefix(vault_path) {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !snapshot_paths.contains(&relative) {
                std::fs::remove_file(existing)?;
            }
        }
    }

    for (relative, content) in snapshot_files {
        let full_path = vault_path.join(&relative);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(full_path, content)?;
    }

    Ok(())
}

#[allow(dead_code)]
pub fn init_repo(vault_path: &Path) -> Result<Repository, git2::Error> {
    open_or_init_meld_repo(vault_path)
}

#[allow(dead_code)]
pub fn auto_commit(vault_path: &Path, message: &str) -> Result<(), Box<dyn std::error::Error>> {
    let files = crate::adapters::vault::list_md_files(vault_path)?;
    auto_commit_files(vault_path, &files, message)
}

pub fn auto_commit_files(
    vault_path: &Path,
    files: &[PathBuf],
    message: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let repo = open_or_init_meld_repo(vault_path)?;
    ensure_vault_gitignore(vault_path)?;

    let mut index = repo.index()?;

    for file in files {
        if let Ok(relative) = file.strip_prefix(vault_path) {
            let content = std::fs::read(file)?;
            let entry = IndexEntry {
                ctime: IndexTime::new(0, 0),
                mtime: IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100644,
                uid: 0,
                gid: 0,
                file_size: content.len().min(u32::MAX as usize) as u32,
                id: git2::Oid::zero(),
                flags: 0,
                flags_extended: 0,
                path: relative.to_string_lossy().replace('\\', "/").into_bytes(),
            };
            index.add_frombuffer(&entry, &content)?;
        }
    }

    index.write()?;

    let tree_id = index.write_tree()?;
    let tree = repo.find_tree(tree_id)?;

    let sig = Signature::now("meld", "meld@local")?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    match parent {
        Some(parent_commit) => {
            // Check if there are actual changes
            let parent_tree = parent_commit.tree()?;
            let diff = repo.diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)?;
            if diff.deltas().len() == 0 {
                return Ok(()); // Nothing to commit
            }

            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent_commit])?;
        }
        None => {
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?;
        }
    }

    Ok(())
}

pub fn get_history(
    vault_path: &Path,
    path_filter: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, Box<dyn std::error::Error>> {
    let repo = Repository::open_bare(meld_git_dir(vault_path))?;

    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;
    revwalk.set_sorting(git2::Sort::TIME)?;

    let target = limit.unwrap_or(50);
    let mut entries = Vec::new();

    for (walked, oid) in revwalk.enumerate() {
        if walked >= MAX_WALK || entries.len() >= target {
            break;
        }

        let oid = oid?;
        let commit = repo.find_commit(oid)?;

        let message = commit.message().unwrap_or("").to_string();

        // Get changed files
        let mut files_changed = Vec::new();
        if let Some(parent) = commit.parents().next() {
            let parent_tree = parent.tree()?;
            let commit_tree = commit.tree()?;
            let diff = repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), None)?;
            for delta in diff.deltas() {
                if let Some(path) = delta.new_file().path() {
                    files_changed.push(path.to_string_lossy().to_string());
                }
            }
        }

        // Skip commits that don't touch the filtered path
        if let Some(filter) = path_filter {
            if !files_changed.iter().any(|f| f == filter) {
                continue;
            }
        }

        entries.push(HistoryEntry {
            id: oid.to_string(),
            message,
            timestamp: commit.time().seconds(),
            files_changed,
        });
    }

    Ok(entries)
}

pub fn get_commit_diff(
    vault_path: &Path,
    commit_id: &str,
) -> Result<CommitDiff, Box<dyn std::error::Error>> {
    let repo = Repository::open_bare(meld_git_dir(vault_path))?;
    let oid = git2::Oid::from_str(commit_id)?;
    let commit = repo.find_commit(oid)?;

    let commit_tree = commit.tree()?;
    let parent_tree = commit.parents().next().and_then(|p| p.tree().ok());

    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;

    let mut files_changed = Vec::new();
    for delta in diff.deltas() {
        if let Some(path) = delta.new_file().path() {
            files_changed.push(path.to_string_lossy().to_string());
        }
    }

    let mut patch = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            patch.push(origin);
        }
        if let Ok(content) = std::str::from_utf8(line.content()) {
            patch.push_str(content);
        }
        true
    })?;

    Ok(CommitDiff {
        id: oid.to_string(),
        message: commit.message().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
        files_changed,
        patch,
    })
}

pub fn revert_commit(vault_path: &Path, commit_id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let repo = Repository::open_bare(meld_git_dir(vault_path))?;
    let oid = git2::Oid::from_str(commit_id)?;
    let commit = repo.find_commit(oid)?;
    let head = repo.head()?.peel_to_commit()?;
    let mainline = if commit.parent_count() > 1 { 1 } else { 0 };

    let mut index = repo.revert_commit(&commit, &head, mainline, None)?;
    if index.has_conflicts() {
        return Err("Revert has conflicts and cannot be applied automatically".into());
    }

    let tree_id = index.write_tree_to(&repo)?;
    let tree = repo.find_tree(tree_id)?;
    let sig = Signature::now("meld", "meld@local")?;

    apply_tree_snapshot_to_vault(&repo, &tree, vault_path)?;

    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("Revert: {}", commit.message().unwrap_or("unknown")),
        &tree,
        &[&head],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{auto_commit, auto_commit_files, get_commit_diff, get_history, revert_commit};
    use std::path::PathBuf;

    fn temp_vault() -> PathBuf {
        std::env::temp_dir().join(format!("meld-git-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn auto_commit_uses_isolated_meld_repo() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        std::fs::write(vault.join("note.md"), "hello").expect("write note");

        auto_commit(&vault, "initial commit").expect("auto commit");

        assert!(vault.join(".meld").join(".git").exists());
        assert!(!vault.join(".git").exists());
        assert!(!get_history(&vault, None, None).expect("history").is_empty());

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn auto_commit_adds_meld_to_user_gitignore_when_user_repo_exists() {
        let vault = temp_vault();
        std::fs::create_dir_all(vault.join(".git")).expect("create fake user .git");
        std::fs::write(vault.join(".gitignore"), "node_modules/\n").expect("write gitignore");
        std::fs::write(vault.join("note.md"), "hello").expect("write note");

        auto_commit(&vault, "initial commit").expect("auto commit");

        let gitignore = std::fs::read_to_string(vault.join(".gitignore")).expect("read gitignore");
        assert!(gitignore.lines().any(|line| line.trim() == ".meld/"));

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn revert_commit_restores_previous_markdown_snapshot() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        std::fs::write(vault.join("note.md"), "v1").expect("write v1");

        auto_commit(&vault, "commit v1").expect("auto commit v1");

        std::fs::write(vault.join("note.md"), "v2").expect("write v2");
        auto_commit(&vault, "commit v2").expect("auto commit v2");

        let history = get_history(&vault, None, None).expect("history");
        let latest_commit = history.first().expect("latest commit");
        revert_commit(&vault, &latest_commit.id).expect("revert commit");

        let restored = std::fs::read_to_string(vault.join("note.md")).expect("read restored note");
        assert_eq!(restored, "v1");

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn auto_commit_files_stages_only_target_markdown_files() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let note_a = vault.join("a.md");
        let note_b = vault.join("b.md");
        std::fs::write(&note_a, "a1").expect("write a1");
        std::fs::write(&note_b, "b1").expect("write b1");
        auto_commit(&vault, "seed").expect("seed commit");

        std::fs::write(&note_a, "a2").expect("write a2");
        std::fs::write(&note_b, "b2").expect("write b2");
        auto_commit_files(&vault, &[note_a.clone()], "commit a only").expect("commit scoped file");

        let history = get_history(&vault, None, None).expect("history");
        let latest = history.first().expect("latest commit");
        assert_eq!(latest.message, "commit a only");
        assert!(latest.files_changed.iter().any(|path| path == "a.md"));
        assert!(!latest.files_changed.iter().any(|path| path == "b.md"));

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn get_history_path_filter_returns_only_matching_commits() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        std::fs::write(vault.join("a.md"), "a1").expect("write a1");
        std::fs::write(vault.join("b.md"), "b1").expect("write b1");
        auto_commit(&vault, "seed both").expect("seed commit");

        std::fs::write(vault.join("a.md"), "a2").expect("write a2");
        auto_commit_files(&vault, &[vault.join("a.md")], "edit a").expect("commit a");

        std::fs::write(vault.join("b.md"), "b2").expect("write b2");
        auto_commit_files(&vault, &[vault.join("b.md")], "edit b").expect("commit b");

        let all = get_history(&vault, None, None).expect("all history");
        assert_eq!(all.len(), 3);

        let only_a = get_history(&vault, Some("a.md"), None).expect("filter a.md");
        assert!(only_a
            .iter()
            .all(|e| e.files_changed.contains(&"a.md".to_string())));
        assert_eq!(only_a.len(), 1); // edit a (seed has no parent → empty files_changed)

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn get_history_limit_caps_results() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        for i in 0..5 {
            std::fs::write(vault.join("note.md"), format!("v{i}")).expect("write");
            auto_commit(&vault, &format!("commit {i}")).expect("commit");
        }

        let limited = get_history(&vault, None, Some(2)).expect("limited history");
        assert_eq!(limited.len(), 2);

        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn get_commit_diff_returns_patch() {
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        std::fs::write(vault.join("note.md"), "line one\n").expect("write v1");
        auto_commit(&vault, "v1").expect("commit v1");

        std::fs::write(vault.join("note.md"), "line one\nline two\n").expect("write v2");
        auto_commit(&vault, "v2").expect("commit v2");

        let history = get_history(&vault, None, Some(1)).expect("history");
        let latest = history.first().expect("latest");

        let diff = get_commit_diff(&vault, &latest.id).expect("diff");
        assert_eq!(diff.id, latest.id);
        assert!(diff.files_changed.contains(&"note.md".to_string()));
        assert!(diff.patch.contains("+line two"));

        let _ = std::fs::remove_dir_all(vault);
    }
}
