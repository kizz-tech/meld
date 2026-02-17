# Vault Rules

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
