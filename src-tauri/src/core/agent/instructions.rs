use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct RuntimeContext {
    pub date: String,
    pub vault_path: String,
    pub note_count: usize,
    pub user_language: Option<String>,
    pub provider: String,
    pub model: String,
    pub tools: Vec<String>,
}

impl RuntimeContext {
    pub fn from_runtime(
        vault_path: &str,
        note_count: usize,
        user_language: Option<&str>,
        provider: &str,
        model: &str,
        tools: &[String],
    ) -> Self {
        let date = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        Self {
            date,
            vault_path: vault_path.to_string(),
            note_count,
            user_language: user_language
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            provider: provider.to_string(),
            model: model.to_string(),
            tools: tools.to_vec(),
        }
    }
}

pub const POLICY_VERSION: &str = "instruction_builder.v6";

const DEFAULT_IDENTITY_AND_SAFETY: &str = r#"You are meld - a knowledgeable collaborator for personal knowledge management.
The vault is shared space between you and the user. You are a co-author, not a tool.

Safety:
- Never claim "created" or "updated" without verification proof (readback_ok=true).
- If a tool fails, explain what happened and propose next step.
- Respond in the user's preferred language from Runtime Context unless the user explicitly requests another language.

Workflow:
- Act first, think minimally. When the task is clear, use tools immediately.
- If a tool returns an error or empty result, inform the user. Never fabricate data that should come from external sources.
- If kb_search returns 0 results, retry with synonyms, broader terms, or the other language if vault is multilingual.
- After completing a multi-step task, verify: did you do everything the user asked? List what was created/modified."#;

#[derive(Debug, Clone, Default)]
pub struct InstructionSources {
    pub agents_md: Option<String>,
    pub rules: Option<String>,
    pub hints: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ComposedSystemPrompt {
    pub prompt: String,
    pub policy_version: String,
    pub policy_fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct InstructionBuilder {
    pub identity_and_safety: String,
}

impl Default for InstructionBuilder {
    fn default() -> Self {
        Self {
            identity_and_safety: DEFAULT_IDENTITY_AND_SAFETY.to_string(),
        }
    }
}

impl InstructionBuilder {
    fn canonical_policy_bundle(&self) -> String {
        self.identity_and_safety.trim().to_string()
    }

    pub fn policy_fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.canonical_policy_bundle().as_bytes());
        hex::encode(hasher.finalize())
    }

    pub fn build(&self, ctx: &RuntimeContext, sources: &InstructionSources) -> String {
        let mut blocks: Vec<String> = Vec::new();
        blocks.push(self.identity_and_safety.trim().to_string());

        if let Some(agents_md) = sources.agents_md.as_deref().map(str::trim) {
            if !agents_md.is_empty() {
                blocks.push(agents_md.to_string());
            }
        }

        if let Some(rules) = sources.rules.as_deref().map(str::trim) {
            if !rules.is_empty() {
                blocks.push(format!("Rules (must follow):\n{rules}"));
            }
        }

        if let Some(hints) = sources.hints.as_deref().map(str::trim) {
            if !hints.is_empty() {
                blocks.push(format!("Hints (guidance):\n{hints}"));
            }
        }

        let tools_block = if ctx.tools.is_empty() {
            "- no tools registered".to_string()
        } else {
            ctx.tools.join("\n")
        };
        blocks.push(format!("Available MCP Tools:\n{tools_block}"));

        blocks.push(format!(
            "Runtime Context:\nCurrent date: {}\nVault path: {}\nTotal notes: {}\nUser language preference: {}\nProvider/model: {}/{}",
            ctx.date,
            ctx.vault_path,
            ctx.note_count,
            ctx.user_language.as_deref().unwrap_or("not set"),
            ctx.provider,
            ctx.model
        ));

        blocks.join("\n\n")
    }
}

pub fn compose_system_prompt_with_metadata(
    vault_path: &str,
    note_count: usize,
    user_language: Option<&str>,
    provider: &str,
    model: &str,
    tool_lines: &[String],
    sources: InstructionSources,
) -> ComposedSystemPrompt {
    let ctx = RuntimeContext::from_runtime(
        vault_path,
        note_count,
        user_language,
        provider,
        model,
        tool_lines,
    );
    let builder = InstructionBuilder::default();

    ComposedSystemPrompt {
        prompt: builder.build(&ctx, &sources),
        policy_version: POLICY_VERSION.to_string(),
        policy_fingerprint: builder.policy_fingerprint(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compose_system_prompt_with_metadata, InstructionBuilder, InstructionSources,
        RuntimeContext, POLICY_VERSION,
    };

    #[test]
    fn build_orders_sources_and_runtime_context() {
        let builder = InstructionBuilder::default();
        let ctx = RuntimeContext {
            date: "2026-02-15 09:00".to_string(),
            vault_path: "/tmp/vault".to_string(),
            note_count: 7,
            user_language: Some("Russian".to_string()),
            provider: "openai".to_string(),
            model: "openai:gpt-5.2".to_string(),
            tools: vec!["- kb_search: search".to_string()],
        };
        let sources = InstructionSources {
            agents_md: Some("# AGENTS\ncustom guidance".to_string()),
            rules: Some("- MUST keep wikilinks".to_string()),
            hints: Some("- SHOULD be concise".to_string()),
        };

        let prompt = builder.build(&ctx, &sources);

        let identity_pos = prompt
            .find("You are meld - a knowledgeable collaborator")
            .expect("identity in prompt");
        let agents_pos = prompt.find("# AGENTS").expect("agents in prompt");
        let rules_pos = prompt
            .find("Rules (must follow):")
            .expect("rules in prompt");
        let hints_pos = prompt.find("Hints (guidance):").expect("hints in prompt");
        let tools_pos = prompt
            .find("Available MCP Tools:")
            .expect("tools in prompt");
        let runtime_pos = prompt.find("Runtime Context:").expect("runtime in prompt");

        assert!(identity_pos < agents_pos);
        assert!(agents_pos < rules_pos);
        assert!(rules_pos < hints_pos);
        assert!(hints_pos < tools_pos);
        assert!(tools_pos < runtime_pos);

        assert!(prompt.contains("Vault path: /tmp/vault"));
        assert!(prompt.contains("Total notes: 7"));
        assert!(prompt.contains("User language preference: Russian"));
        assert!(prompt.contains("Provider/model: openai/openai:gpt-5.2"));
    }

    #[test]
    fn compose_returns_policy_metadata() {
        let composed = compose_system_prompt_with_metadata(
            "/tmp/vault",
            3,
            Some("English"),
            "openai",
            "openai:gpt-5.2",
            &["- kb_search: search".to_string()],
            InstructionSources::default(),
        );
        assert!(!composed.prompt.is_empty());
        assert_eq!(composed.policy_version, POLICY_VERSION);
        assert_eq!(composed.policy_fingerprint.len(), 64);
    }
}
